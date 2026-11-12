/**
 * ResumeWorker sem Redis nem Postgres: matriz ack/retentativa do handler, conferência de ids do
 * evento contra o thread, TenantContext do evento, logs só com ids e ciclo de vida do consumo.
 */
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@carina/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import {
  ApprovalConflictError,
  NotFoundError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import type { ConsumeOptions } from "../../core/redis/streams.service.js";
import { RESUME_GROUP, RESUME_STREAM, ResumeWorker, type ResumeLogger } from "./resume.worker.js";
import type { Execution, GraphStateValue } from "./state.js";

const T = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const APPROVAL = "a".repeat(64);
const THREAD = `${T}:${C}:conversa-1`;

type Resume = Extract<StreamEvent, { type: "resume" }>;

const resumeEvent = (over: Partial<Resume> = {}): Resume => ({
  eventId: randomUUID(),
  type: "resume",
  tenantId: T,
  clientId: C,
  approvalId: APPROVAL,
  threadId: THREAD,
  approved: true,
  ...over,
});

const ALLOWED_LOG_KEYS = new Set([
  "msg",
  "err",
  "eventId",
  "tenantId",
  "clientId",
  "approvalId",
  "threadId",
  "status",
]);

function setup(
  opts: {
    pending?: string | null;
    resume?: (threadId: string, approved: boolean) => Promise<{ execution: Execution }>;
    workers?: "true" | "false";
    consume?: (o: ConsumeOptions) => Promise<void>;
  } = {},
) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies ResumeLogger;
  const contexts: unknown[] = [];
  const pending = opts.pending === undefined ? APPROVAL : opts.pending;
  const orchestrator = {
    finalState: vi.fn(async () => {
      contexts.push(TenantContext.current());
      return { pending: pending === null ? null : { approvalId: pending } } as GraphStateValue;
    }),
    resume: vi.fn(
      opts.resume ??
        (async () => {
          contexts.push(TenantContext.current());
          return { execution: { approvalId: APPROVAL, status: "succeeded" } as Execution };
        }),
    ),
  };
  const streams = { consume: vi.fn(opts.consume ?? (async () => undefined)) };
  const worker = new ResumeWorker(
    { WORKERS_ENABLED: opts.workers ?? "false" },
    streams as never,
    orchestrator as never,
    logger,
  );
  return { worker, logger, orchestrator, streams, contexts };
}

function allLogs(logger: ReturnType<typeof setup>["logger"]) {
  return [logger.info, logger.warn, logger.error].flatMap((f) =>
    f.mock.calls.map((c) => c[0] as Record<string, unknown>),
  );
}

describe("ResumeWorker.handle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ignora (ACK) eventos que não são resume", async () => {
    const { worker, orchestrator } = setup();
    await worker.handle({
      eventId: randomUUID(),
      type: "data.ingested",
      tenantId: T,
      clientId: C,
      source: "api",
    });
    expect(orchestrator.finalState).not.toHaveBeenCalled();
    expect(orchestrator.resume).not.toHaveBeenCalled();
  });

  it("retoma sob TenantContext { tenantId, clientId } do evento e registra só ids", async () => {
    const { worker, orchestrator, contexts, logger } = setup();
    const e = resumeEvent({ approved: false });
    await worker.handle(e);
    expect(orchestrator.resume).toHaveBeenCalledWith(THREAD, false);
    expect(contexts).toEqual([
      { tenantId: T, clientId: C },
      { tenantId: T, clientId: C },
    ]);
    expect(logger.info).toHaveBeenCalledWith({
      msg: expect.any(String),
      eventId: e.eventId,
      tenantId: T,
      clientId: C,
      approvalId: APPROVAL,
      threadId: THREAD,
      status: "succeeded",
    });
  });

  it("ids em caixa diferente da do thread ainda conferem", async () => {
    const { worker, orchestrator } = setup();
    await worker.handle(resumeEvent({ tenantId: T.toUpperCase(), clientId: C.toUpperCase() }));
    expect(orchestrator.resume).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tenant do evento diferente do thread", { tenantId: OTHER }],
    ["cliente do evento diferente do thread", { clientId: OTHER }],
    ["thread de outro tenant", { threadId: `${OTHER}:${C}:conversa-1` }],
    ["threadId malformado", { threadId: "qualquer-coisa" }],
    ["tenantId que não é uuid", { tenantId: "nao-uuid", threadId: `nao-uuid:${C}:x` }],
    ["approvalId vazio", { approvalId: "" }],
  ])("evento forjado/inválido (%s): ACK com log de erro, nada roda", async (_, over) => {
    const { worker, orchestrator, logger } = setup();
    await expect(worker.handle(resumeEvent(over))).resolves.toBeUndefined();
    expect(orchestrator.finalState).not.toHaveBeenCalled();
    expect(orchestrator.resume).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields] = logger.error.mock.calls[0] as [Record<string, unknown>];
    expect(fields["msg"]).toEqual(expect.any(String));
  });

  it("ids longos no log são cortados", async () => {
    const { worker, logger } = setup();
    await worker.handle(resumeEvent({ threadId: "x".repeat(5000), approvalId: "y".repeat(5000) }));
    const [fields] = logger.error.mock.calls[0] as [Record<string, string>];
    expect(fields["threadId"]?.length).toBeLessThanOrEqual(256);
    expect(fields["approvalId"]?.length).toBeLessThanOrEqual(256);
  });

  it("thread sem aprovação pendente ou com OUTRA aprovação: ACK (terminal), sem retomar", async () => {
    for (const pending of [null, "b".repeat(64)]) {
      const { worker, orchestrator, logger } = setup({ pending });
      await expect(worker.handle(resumeEvent())).resolves.toBeUndefined();
      expect(orchestrator.resume).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    }
  });

  it("NotFoundError do orquestrador é TERMINAL: ACK com warn e ids, sem relançar", async () => {
    const err = new NotFoundError("Thread sem aprovação pendente");
    const { worker, logger } = setup({ resume: () => Promise.reject(err) });
    const e = resumeEvent();
    await expect(worker.handle(e)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({
      msg: expect.any(String),
      err,
      eventId: e.eventId,
      tenantId: T,
      clientId: C,
      approvalId: APPROVAL,
      threadId: THREAD,
    });
  });

  it("NotFoundError na leitura do thread também é terminal", async () => {
    const { worker, orchestrator, logger } = setup();
    orchestrator.finalState.mockRejectedValueOnce(new NotFoundError("Thread não encontrado"));
    await expect(worker.handle(resumeEvent())).resolves.toBeUndefined();
    expect(orchestrator.resume).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("ValidationError do orquestrador é terminal (ACK com erro)", async () => {
    const err = new ValidationError("threadId inválido no grafo");
    const { worker, logger } = setup({ resume: () => Promise.reject(err) });
    await expect(worker.handle(resumeEvent())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err }));
  });

  it("ApprovalConflictError (banco ainda pending): relança para a reentrega (sem ACK)", async () => {
    const err = new ApprovalConflictError("A aprovação ainda não foi decidida");
    const { worker, logger } = setup({ resume: () => Promise.reject(err) });
    await expect(worker.handle(resumeEvent())).rejects.toBe(err);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("qualquer outro erro: log de erro com err no topo e relança (reentrega até a DLQ)", async () => {
    const err = new Error("banco caiu");
    const { worker, logger } = setup({ resume: () => Promise.reject(err) });
    await expect(worker.handle(resumeEvent())).rejects.toBe(err);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err }));
  });

  it("logs nunca levam campos além de msg, err e ids", async () => {
    const cases: Parameters<typeof setup>[0][] = [
      {},
      { pending: null },
      { resume: () => Promise.reject(new NotFoundError("x")) },
      { resume: () => Promise.reject(new ApprovalConflictError("x")) },
      { resume: () => Promise.reject(new Error("x")) },
    ];
    for (const c of cases) {
      const { worker, logger } = setup(c);
      await worker.handle(resumeEvent()).catch(() => undefined);
      await worker.handle(resumeEvent({ tenantId: OTHER })).catch(() => undefined);
      const logs = allLogs(logger);
      expect(logs.length).toBeGreaterThan(0);
      for (const fields of logs) {
        for (const key of Object.keys(fields)) expect(ALLOWED_LOG_KEYS).toContain(key);
      }
    }
  });
});

describe("ResumeWorker ciclo de vida", () => {
  it("WORKERS_ENABLED=false: não consome", () => {
    const { worker, streams } = setup({ workers: "false" });
    worker.onApplicationBootstrap();
    expect(worker.running).toBe(false);
    expect(streams.consume).not.toHaveBeenCalled();
  });

  it("liga no bootstrap com o grupo resumers em jobs e para esperando o loop", async () => {
    let finished = false;
    const { worker, streams } = setup({
      workers: "true",
      consume: (o) =>
        new Promise<void>((resolve) => {
          o.signal.addEventListener("abort", () => {
            // simula a mensagem em andamento terminando depois do abort
            setTimeout(() => {
              finished = true;
              resolve();
            }, 20);
          });
        }),
    });
    worker.onApplicationBootstrap();
    worker.onApplicationBootstrap(); // idempotente
    expect(worker.running).toBe(true);
    expect(streams.consume).toHaveBeenCalledTimes(1);
    const opts = streams.consume.mock.calls[0]?.[0] as ConsumeOptions;
    expect(opts.stream).toBe(RESUME_STREAM);
    expect(opts.group).toBe(RESUME_GROUP);
    expect(RESUME_GROUP).toBe("resumers");
    expect(opts.consumer).toEqual(expect.any(String));
    await worker.onModuleDestroy();
    expect(finished).toBe(true);
    expect(worker.running).toBe(false);
    await worker.beforeApplicationShutdown(); // idempotente
  });

  it("dois workers têm nomes de consumidor distintos", () => {
    const a = setup({ workers: "true", consume: (o) => abortable(o) });
    const b = setup({ workers: "true", consume: (o) => abortable(o) });
    a.worker.start();
    b.worker.start();
    const ca = (a.streams.consume.mock.calls[0]?.[0] as ConsumeOptions).consumer;
    const cb = (b.streams.consume.mock.calls[0]?.[0] as ConsumeOptions).consumer;
    expect(ca).not.toBe(cb);
    return Promise.all([a.worker.stop(), b.worker.stop()]);
  });

  it("consume que falha é reiniciado (com log) até o stop", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { worker, logger } = setup({
        workers: "true",
        consume: async (o) => {
          calls++;
          if (calls === 1) throw new Error("redis fora");
          await abortable(o);
        },
      });
      worker.start();
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toBe(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.any(String), err: expect.any(Error) }),
      );
      await worker.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function abortable(o: ConsumeOptions): Promise<void> {
  return new Promise((resolve) => {
    if (o.signal.aborted) resolve();
    o.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
