/**
 * Contrato do handler do SyncWorker com dependências falsas: erro permanente (ids inválidos,
 * cliente desconhecido) é logado (warn) e confirmado; erro transitório, lock ocupado ou lock
 * perdido são relançados (a entrada fica pendente e o StreamsService reentrega).
 */
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@carina/shared";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../core/config/env.js";
import { LockLostError, type LockHandle, type LockService } from "../../core/redis/lock.service.js";
import type { StreamsService } from "../../core/redis/streams.service.js";
import type { KnowledgeService } from "../knowledge/knowledge.service.js";
import type { IngestionService } from "./ingestion.service.js";
import { SYNC_LOCK_TTL_MS, SyncBusyError, SyncWorker, syncLockKey } from "./sync.worker.js";

const tenantId = randomUUID();
const clientId = randomUUID();

const event = (over: Partial<Record<string, string>> = {}): StreamEvent =>
  ({
    eventId: randomUUID(),
    type: "data.ingested",
    tenantId,
    clientId,
    source: "api",
    ...over,
  }) as StreamEvent;

function lockHandle(over: Partial<LockHandle> = {}): LockHandle {
  return {
    key: "k",
    token: "t",
    lost: false,
    assertHeld: vi.fn(async () => undefined),
    renew: vi.fn(async () => true),
    release: vi.fn(async () => true),
    ...over,
  };
}

function setup(opts: {
  ingestion?: Partial<IngestionService>;
  knowledge?: Partial<KnowledgeService>;
  acquire?: LockService["acquire"];
}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handle = lockHandle();
  const acquire = vi.fn(opts.acquire ?? (async () => handle));
  const worker = new SyncWorker(
    { WORKERS_ENABLED: "false" } as Pick<Env, "WORKERS_ENABLED">,
    {} as StreamsService,
    {
      clientExists: async () => true,
      iteratePositions: async function* () {
        yield [];
      },
      iterateTransactions: async function* () {
        yield [];
      },
      ...opts.ingestion,
    } as unknown as IngestionService,
    { ingestDocument: async () => ({ documentId: "d", chunkIds: [] }), ...opts.knowledge } as never,
    { acquire } as unknown as LockService,
    logger,
  );
  return { worker, logger, handle, acquire };
}

describe("SyncWorker.handle", () => {
  it("falha não permanente (ex.: banco fora) é logada como error e relançada; o lock é liberado", async () => {
    const boom = new Error("conexão recusada");
    const { worker, logger, handle } = setup({
      ingestion: {
        clientExists: async () => {
          throw boom;
        },
      },
    });
    await expect(worker.handle(event())).rejects.toBe(boom);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.any(String), err: boom, tenantId, clientId }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("lock ocupado: SyncBusyError relançado, log em info, nada lido", async () => {
    const clientExists = vi.fn(async () => true);
    const { worker, logger, acquire } = setup({
      acquire: async () => null,
      ingestion: { clientExists },
    });
    await expect(worker.handle(event())).rejects.toBeInstanceOf(SyncBusyError);
    expect(acquire).toHaveBeenCalledWith(syncLockKey(tenantId, clientId), SYNC_LOCK_TTL_MS);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.any(String), tenantId, clientId }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(clientExists).not.toHaveBeenCalled();
  });

  it("lock perdido antes de escrever: relança sem escrever nada", async () => {
    const ingestDocument = vi.fn(async () => ({ documentId: "d", chunkIds: [] }));
    const lost = lockHandle({
      assertHeld: vi.fn(async () => {
        throw new LockLostError("k");
      }),
    });
    const { worker, logger } = setup({
      acquire: async () => lost,
      knowledge: { ingestDocument } as never,
      ingestion: {
        iteratePositions: async function* () {
          yield [
            {
              externalId: "p1",
              institution: "XP",
              kind: "investment",
              assetClass: "acao",
              assetCode: "PETR4",
              name: "Petrobras",
              valueBrl: "10.00",
              asOf: "2026-11-10",
            },
          ];
        },
      } as never,
    });
    await expect(worker.handle(event())).rejects.toBeInstanceOf(LockLostError);
    expect(ingestDocument).not.toHaveBeenCalled();
    expect(lost.release).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it("ValidationError (ids não-uuid) e NotFound (cliente desconhecido): warn + ACK", async () => {
    const { worker, logger } = setup({ ingestion: { clientExists: async () => false } });
    await expect(worker.handle(event({ tenantId: "x" }))).resolves.toBeUndefined();
    await expect(worker.handle(event())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const [fields] of logger.warn.mock.calls) {
      expect(fields).toEqual(
        expect.objectContaining({ msg: expect.any(String), err: expect.any(Error) }),
      );
    }
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("outros tipos de evento: ACK sem tocar no lock", async () => {
    const { worker, acquire } = setup({});
    await expect(
      worker.handle({ ...event(), type: "notification", kind: "info", text: "x" } as StreamEvent),
    ).resolves.toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("a chave do lock é por (tenant, cliente), sem diferença de caixa no uuid", () => {
    expect(syncLockKey(tenantId.toUpperCase(), clientId)).toBe(`sync:lock:${tenantId}:${clientId}`);
  });
});
