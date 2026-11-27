import type { NormalizedPosition, NormalizedTransaction, StreamEvent } from "@carina/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import { ImportWorker, type ImportLogger } from "./import.worker.js";
import type { ParsedFile } from "./parse-file.js";

const parseFileMock = vi.hoisted(() => vi.fn());
vi.mock("./parse-file.js", async (orig) => ({
  ...(await orig<typeof import("./parse-file.js")>()),
  parseFile: parseFileMock,
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const SECRET = "Padaria Secreta";
const TOKEN = "55555555-5555-4555-8555-555555555555";

const event = (over: Partial<Record<string, string>> = {}): StreamEvent => ({
  eventId: "44444444-4444-4444-8444-444444444444",
  type: "import.requested",
  tenantId: TENANT,
  clientId: CLIENT,
  importJobId: JOB,
  ...over,
});

const tx = (n: number): NormalizedTransaction => ({
  externalId: `t${n.toString()}`,
  institution: "Banco",
  account: "cc",
  date: "2025-10-01",
  description: SECRET,
  amountBrl: "10.00",
  kind: "debit",
});

const pos = (n: number): NormalizedPosition => ({
  externalId: `p${n.toString()}`,
  institution: "XP",
  kind: "investment",
  assetClass: "acao",
  name: SECRET,
  valueBrl: "10.00",
  asOf: "2025-10-31",
});

const parsed = (over: Partial<ParsedFile> = {}): ParsedFile => ({
  positions: [],
  transactions: [],
  errors: [],
  stats: { rowsRead: 0, positions: 0, transactions: 0, errorRows: 0, ignored: {} },
  ...over,
});

function setup(
  opts: { format?: string; options?: unknown; claim?: unknown; touch?: boolean } = {},
) {
  const claimed = {
    job: {
      id: JOB,
      format: opts.format ?? "csv",
      options: opts.options ?? {
        format: "csv",
        csvPreset: "generico_br",
        institution: "Banco",
        account: "cc",
      },
      client: { id: CLIENT, externalId: "c1" },
    },
    bytes: new Uint8Array([1, 2, 3]),
    claimToken: TOKEN,
  };
  const repo = {
    claim: vi.fn().mockResolvedValue(opts.claim === undefined ? claimed : opts.claim),
    touchProgress: vi.fn().mockResolvedValue(opts.touch ?? true),
    finish: vi.fn().mockResolvedValue(true),
    insertAudit: vi.fn(),
  };
  const ingestion = {
    upsertTransactionsFor: vi.fn((_c: unknown, _s: string, items: unknown[]) =>
      Promise.resolve({ upserted: items.length, usage: {} }),
    ),
    replaceImportedPositions: vi.fn((_c: unknown, input: { items: unknown[] }) =>
      Promise.resolve({ upserted: input.items.length, removed: 0, stale: false, usage: {} }),
    ),
  };
  const publish = vi.fn().mockResolvedValue("1-0");
  const logger: ImportLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const db = { tx: vi.fn((fn: (t: unknown) => unknown) => fn({ tx: true })) };
  const worker = new ImportWorker(
    { WORKERS_ENABLED: "false", IMPORT_PARSE_MAX_HEAP_MB: 768 },
    { publish, consume: vi.fn() } as never,
    db as never,
    repo as never,
    ingestion as never,
    logger,
  );
  type Published = Record<string, unknown> & { stream: string; type: string };
  const published = (): Published[] =>
    publish.mock.calls.map(([stream, e]) => ({ ...(e as Published), stream: stream as string }));
  return { worker, repo, ingestion, publish, published, logger, db };
}

/** Tudo o que saiu para log e eventos, serializado (para procurar conteúdo do arquivo). */
const everything = (s: ReturnType<typeof setup>) =>
  JSON.stringify([
    vi.mocked(s.logger.info).mock.calls,
    vi.mocked(s.logger.warn).mock.calls,
    vi.mocked(s.logger.error).mock.calls,
    s.publish.mock.calls,
    s.repo.finish.mock.calls,
  ]);

describe("ImportWorker.handle", () => {
  beforeEach(() => {
    parseFileMock.mockReset();
  });

  it("ignora outros tipos de evento (ACK sem efeito)", async () => {
    const s = setup();
    await s.worker.handle({
      eventId: "44444444-4444-4444-8444-444444444444",
      type: "data.ingested",
      tenantId: TENANT,
      clientId: CLIENT,
      source: "api",
    });
    expect(s.repo.claim).not.toHaveBeenCalled();
  });

  it("ids que não são uuid → warn e ACK, sem tocar o banco", async () => {
    const s = setup();
    await s.worker.handle(event({ importJobId: "x" }));
    await s.worker.handle(event({ tenantId: "x" }));
    expect(s.repo.claim).not.toHaveBeenCalled();
    expect(s.logger.warn).toHaveBeenCalledTimes(2);
  });

  it("claim no contexto do tenant e do cliente; claim null (já tomado) → ACK sem efeito", async () => {
    const s = setup({ claim: null });
    s.repo.claim.mockImplementation(() => {
      expect(TenantContext.current()).toEqual({ tenantId: TENANT, clientId: CLIENT });
      return Promise.resolve(null);
    });
    await s.worker.handle(event());
    expect(s.repo.claim).toHaveBeenCalledWith(JOB);
    expect(parseFileMock).not.toHaveBeenCalled();
    expect(s.publish).not.toHaveBeenCalled();
  });

  it("claim lança (ex.: banco fora) → relança para o evento ser reentregue", async () => {
    const s = setup();
    s.repo.claim.mockRejectedValue(new Error("db down"));
    await expect(s.worker.handle(event())).rejects.toThrow("db down");
    expect(s.logger.error).toHaveBeenCalled();
  });

  it("passa IMPORT_PARSE_MAX_HEAP_MB do ambiente como limite de heap do parse", async () => {
    const s = setup();
    parseFileMock.mockResolvedValue(parsed({ failure: "unreadable" }));
    await s.worker.handle(event());
    expect(parseFileMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { maxHeapMb: 768 },
    );
  });

  it("falha do parser → finish(failed, código) com auditoria e import.finished failed", async () => {
    const s = setup();
    parseFileMock.mockResolvedValue(parsed({ failure: "unreadable" }));
    await s.worker.handle(event());
    expect(s.repo.finish).toHaveBeenCalledWith({ tx: true }, JOB, TOKEN, {
      status: "failed",
      failureCode: "unreadable",
      stats: expect.objectContaining({ transactions: 0 }),
      errors: [],
    });
    expect(s.repo.insertAudit).toHaveBeenCalledWith({ tx: true }, "import.finished:failed");
    expect(s.ingestion.upsertTransactionsFor).not.toHaveBeenCalled();
    expect(s.published()).toEqual([
      expect.objectContaining({
        stream: "inbox.events",
        type: "import.progress",
        stage: "parsing",
      }),
      expect.objectContaining({
        stream: "inbox.events",
        type: "import.finished",
        importJobId: JOB,
        status: "failed",
      }),
    ]);
  });

  it("2 500 transações → 3 lotes, progresso 1000/2000/2500 e done", async () => {
    const s = setup();
    const transactions = Array.from({ length: 2500 }, (_, i) => tx(i));
    parseFileMock.mockResolvedValue(
      parsed({
        transactions,
        stats: { rowsRead: 2500, positions: 0, transactions: 2500, errorRows: 0, ignored: {} },
      }),
    );
    await s.worker.handle(event());
    expect(s.ingestion.upsertTransactionsFor.mock.calls.map((c) => [c[1], c[2].length])).toEqual([
      ["import", 1000],
      ["import", 1000],
      ["import", 500],
    ]);
    expect(s.ingestion.upsertTransactionsFor.mock.calls[0]?.[0]).toEqual({
      id: CLIENT,
      externalId: "c1",
    });
    expect(s.repo.touchProgress).toHaveBeenCalledTimes(3);
    expect(s.repo.touchProgress).toHaveBeenCalledWith(JOB, TOKEN);
    const progress = s
      .published()
      .filter((e) => e.type === "import.progress")
      .map((e) => {
        const p = e as unknown as { stage: string; processed: number; total: number };
        return [p.stage, p.processed, p.total];
      });
    expect(progress).toEqual([
      ["parsing", 0, 0],
      ["writing", 1000, 2500],
      ["writing", 2000, 2500],
      ["writing", 2500, 2500],
    ]);
    expect(s.repo.finish).toHaveBeenCalledWith(expect.anything(), JOB, TOKEN, {
      status: "done",
      failureCode: null,
      stats: expect.objectContaining({ rowsRead: 2500, transactions: 2500 }),
      errors: [],
    });
    expect(s.published().at(-1)).toMatchObject({ type: "import.finished", status: "done" });
    expect(everything(s)).not.toContain(SECRET);
  });

  it("B3: posições substituem pelas instituições do arquivo, com o asOf do upload", async () => {
    const s = setup({ format: "b3_xlsx", options: { format: "b3_xlsx", asOf: "2025-10-31" } });
    parseFileMock.mockResolvedValue(
      parsed({ positions: [pos(1), pos(2)], positionInstitutions: ["XP"], transactions: [tx(1)] }),
    );
    await s.worker.handle(event());
    expect(s.ingestion.replaceImportedPositions).toHaveBeenCalledWith(
      { id: CLIENT, externalId: "c1" },
      { institutions: ["XP"], keepInstitutions: [], asOf: "2025-10-31", items: [pos(1), pos(2)] },
    );
    expect(s.repo.finish).toHaveBeenCalledWith(expect.anything(), JOB, TOKEN, {
      status: "done",
      failureCode: null,
      stats: expect.objectContaining({ positions: 2, transactions: 1 }),
      errors: [],
    });
  });

  it("B3: instituição com linha recusada vai em keepInstitutions (posições antigas mantidas)", async () => {
    const s = setup({ format: "b3_xlsx", options: { format: "b3_xlsx", asOf: "2025-10-31" } });
    parseFileMock.mockResolvedValue(
      parsed({
        positions: [pos(1)],
        positionInstitutions: ["XP", "BB"],
        partialInstitutions: ["XP"],
      }),
    );
    await s.worker.handle(event());
    expect(s.ingestion.replaceImportedPositions).toHaveBeenCalledWith(
      { id: CLIENT, externalId: "c1" },
      { institutions: ["XP", "BB"], keepInstitutions: ["XP"], asOf: "2025-10-31", items: [pos(1)] },
    );
  });

  it("B3 com fotografia mais antiga: todas as posições viram stale_snapshot; nada gravado → no_valid_rows", async () => {
    const s = setup({ format: "b3_xlsx", options: { format: "b3_xlsx", asOf: "2025-10-31" } });
    s.ingestion.replaceImportedPositions.mockResolvedValue({
      upserted: 0,
      removed: 0,
      stale: true,
      usage: {},
    });
    parseFileMock.mockResolvedValue(
      parsed({
        positions: [pos(1), pos(2)],
        positionInstitutions: ["XP"],
        stats: { rowsRead: 2, positions: 2, transactions: 0, errorRows: 0, ignored: {} },
      }),
    );
    await s.worker.handle(event());
    const call = s.repo.finish.mock.calls[0]?.[3] as {
      status: string;
      failureCode: string;
      stats: { positions: number; errorRows: number };
      errors: { code: string }[];
    };
    expect(call.status).toBe("failed");
    expect(call.failureCode).toBe("no_valid_rows");
    expect(call.stats).toMatchObject({ positions: 0, errorRows: 2 });
    expect(call.errors.map((e) => e.code)).toEqual(["stale_snapshot", "stale_snapshot"]);
  });

  it("erro inesperado no meio da gravação → failed/internal com o que foi gravado; ACK; log sem conteúdo", async () => {
    const s = setup();
    parseFileMock.mockResolvedValue(
      parsed({ transactions: Array.from({ length: 1500 }, (_, i) => tx(i)) }),
    );
    s.ingestion.upsertTransactionsFor
      .mockResolvedValueOnce({ upserted: 1000, usage: {} })
      .mockRejectedValueOnce(new Error(`falha com ${SECRET}`));
    await s.worker.handle(event());
    expect(s.repo.finish).toHaveBeenCalledWith(expect.anything(), JOB, TOKEN, {
      status: "failed",
      failureCode: "internal",
      stats: expect.objectContaining({ transactions: 1000 }),
      errors: [],
    });
    expect(s.published().at(-1)).toMatchObject({ type: "import.finished", status: "failed" });
    expect(s.logger.error).toHaveBeenCalled();
    expect(everything(s)).not.toContain(SECRET);
  });

  it("opções guardadas inválidas → failed/internal", async () => {
    const s = setup({ options: { format: "csv" } });
    await s.worker.handle(event());
    expect(parseFileMock).not.toHaveBeenCalled();
    expect(s.repo.finish.mock.calls[0]?.[3]).toMatchObject({
      status: "failed",
      failureCode: "internal",
    });
  });

  it("job tirado do worker (limpeza marcou stuck) → para de gravar e não fecha nem publica término", async () => {
    const s = setup({ touch: false });
    parseFileMock.mockResolvedValue(
      parsed({ transactions: Array.from({ length: 2500 }, (_, i) => tx(i)) }),
    );
    await s.worker.handle(event());
    expect(s.ingestion.upsertTransactionsFor).toHaveBeenCalledTimes(1);
    expect(s.repo.finish).not.toHaveBeenCalled();
    expect(s.published().some((e) => e.type === "import.finished")).toBe(false);
    expect(s.logger.warn).toHaveBeenCalled();
  });

  it("finish devolve false (job já não está parsing) → sem import.finished", async () => {
    const s = setup();
    s.repo.finish.mockResolvedValue(false);
    parseFileMock.mockResolvedValue(parsed({ transactions: [tx(1)] }));
    await s.worker.handle(event());
    expect(s.repo.insertAudit).not.toHaveBeenCalled();
    expect(s.published().some((e) => e.type === "import.finished")).toBe(false);
  });

  it("falha ao publicar eventos não derruba a importação", async () => {
    const s = setup();
    s.publish.mockRejectedValue(new Error("redis fora"));
    parseFileMock.mockResolvedValue(parsed({ transactions: [tx(1)] }));
    await s.worker.handle(event());
    expect(s.repo.finish.mock.calls[0]?.[3]).toMatchObject({ status: "done" });
    expect(s.logger.error).toHaveBeenCalled();
  });

  it("o fechamento em melhor esforço também falhando é só registrado (ACK)", async () => {
    const s = setup();
    parseFileMock.mockRejectedValue(new Error("thread"));
    s.repo.finish.mockRejectedValue(new Error("db"));
    await expect(s.worker.handle(event())).resolves.toBeUndefined();
    expect(vi.mocked(s.logger.error).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ImportWorker: ciclo de vida", () => {
  it("WORKERS_ENABLED=false não liga; start/stop são idempotentes", async () => {
    const s = setup();
    s.worker.onApplicationBootstrap();
    expect(s.worker.running).toBe(false);
    const consume = vi.fn(({ signal }: { signal: AbortSignal }) => {
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const worker = new ImportWorker(
      { WORKERS_ENABLED: "true", IMPORT_PARSE_MAX_HEAP_MB: 512 },
      { publish: vi.fn(), consume } as never,
      {} as never,
      {} as never,
      {} as never,
      s.logger,
    );
    worker.onApplicationBootstrap();
    worker.start();
    expect(worker.running).toBe(true);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]?.[0]).toMatchObject({ stream: "jobs", group: "imports" });
    await worker.onModuleDestroy();
    await worker.beforeApplicationShutdown();
    expect(worker.running).toBe(false);
  });

  it("avisa no boot quando uma flag de heap do processo anula o limite do V8 da thread", async () => {
    vi.stubEnv("NODE_OPTIONS", "--use-openssl-ca --max-old-space-size=8192");
    const logger: ImportLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const consume = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const worker = new ImportWorker(
      { WORKERS_ENABLED: "true", IMPORT_PARSE_MAX_HEAP_MB: 512 },
      { publish: vi.fn(), consume } as never,
      {} as never,
      {} as never,
      {} as never,
      logger,
    );
    try {
      worker.onApplicationBootstrap();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ flag: "--max-old-space-size", maxHeapMb: 512 }),
      );
    } finally {
      await worker.stop();
      vi.unstubAllEnvs();
    }
  });
});
