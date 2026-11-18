import { describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import {
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { ImportsService, type ImportsLogger } from "./imports.service.js";
import type { ImportsRepository } from "./imports.repository.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

const OFX = Buffer.from("OFXHEADER:100\nDATA:OFXSGML\n\n<OFX></OFX>");
const CSV = Buffer.from("Data;Valor;Descrição\n01/10/2026;-10,00;Mercado\n");

const view = { id: JOB, status: "queued" };

function setup(over: Partial<Record<keyof ImportsRepository, unknown>> = {}) {
  const repo = {
    lockUploads: vi.fn(),
    findBySha: vi.fn().mockResolvedValue(null),
    countActive: vi.fn().mockResolvedValue(0),
    insertQueued: vi.fn().mockResolvedValue(JOB),
    insertFile: vi.fn(),
    insertAudit: vi.fn(),
    requeue: vi.fn().mockResolvedValue(true),
    view: vi.fn().mockResolvedValue(view),
    get: vi.fn(),
    list: vi.fn(),
    ...over,
  };
  const publish = vi.fn().mockResolvedValue("1-0");
  const logger: ImportsLogger = { error: vi.fn() };
  const svc = new ImportsService(
    { resolve: vi.fn().mockResolvedValue({ id: CLIENT, externalId: "c1" }) } as never,
    { tx: (fn: (tx: unknown) => unknown) => fn({}) } as never,
    repo as never,
    { publish } as never,
    logger,
  );
  const run = <T>(fn: () => Promise<T>) => TenantContext.run({ tenantId: TENANT }, fn);
  return { svc, repo, publish, logger, run };
}

describe("ImportsService.create: recusas síncronas (nada tocado)", () => {
  it.each([
    ["arquivo vazio", Buffer.alloc(0), {}],
    ["formato desconhecido", Buffer.from([1, 2, 3, 4, 0, 0]), {}],
    ["format incoerente", OFX, { format: "csv" as const }],
    ["CSV sem account", CSV, { csvPreset: "generico_br", institution: "B" }],
    ["CSV sem mapeamento", CSV, { institution: "B", account: "c" }],
    ["csvMapping não é JSON", CSV, { csvMapping: "{x", institution: "B", account: "c" }],
    ["preset inexistente", CSV, { csvPreset: "toString", institution: "B", account: "c" }],
  ])("%s → ValidationError", async (_n, bytes, fields) => {
    const { svc, repo, publish, run } = setup();
    await expect(run(() => svc.create("c1", { bytes }, fields))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(repo.lockUploads).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("a mensagem de erro de opções não repete o valor enviado", async () => {
    const { svc, run } = setup();
    const err = await run(() =>
      svc.create("c1", { bytes: CSV }, { csvPreset: "SEGREDO", institution: "B", account: "c" }),
    ).then(
      () => new Error("deveria recusar"),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).not.toContain("SEGREDO");
  });
});

describe("ImportsService.create: fluxo", () => {
  it("job novo: grava, audita e publica depois do COMMIT", async () => {
    const { svc, repo, publish, run } = setup();
    const out = await run(() => svc.create("c1", { bytes: OFX, originalName: "a/b.ofx" }, {}));
    expect(out).toEqual({ job: view, created: true });
    expect(repo.insertQueued).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: "ofx", fileName: "b.ofx", options: { format: "ofx" } }),
    );
    expect(repo.insertFile).toHaveBeenCalled();
    expect(repo.insertAudit).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      "jobs",
      expect.objectContaining({ type: "import.requested", importJobId: JOB, clientId: CLIENT }),
    );
  });

  it.each(["queued", "parsing", "done"])(
    "existente %s: created false, nada gravado",
    async (status) => {
      const { svc, repo, publish, run } = setup({
        findBySha: vi.fn().mockResolvedValue({ id: JOB, status }),
      });
      const out = await run(() => svc.create("c1", { bytes: OFX }, {}));
      expect(out.created).toBe(false);
      expect(repo.requeue).not.toHaveBeenCalled();
      expect(repo.insertQueued).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("existente failed: reenfileira e regrava os bytes", async () => {
    const { svc, repo, publish, run } = setup({
      findBySha: vi.fn().mockResolvedValue({ id: JOB, status: "failed" }),
    });
    const out = await run(() => svc.create("c1", { bytes: OFX }, {}));
    expect(out.created).toBe(true);
    expect(repo.requeue).toHaveBeenCalledWith(expect.anything(), JOB, { format: "ofx" }, "arquivo");
    expect(repo.insertFile).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("failed que outro processo já reenfileirou: created false", async () => {
    const { svc, repo, run } = setup({
      findBySha: vi.fn().mockResolvedValue({ id: JOB, status: "failed" }),
      requeue: vi.fn().mockResolvedValue(false),
    });
    expect((await run(() => svc.create("c1", { bytes: OFX }, {}))).created).toBe(false);
    expect(repo.insertFile).not.toHaveBeenCalled();
  });

  it("5 ativos: RateLimitedError com Retry-After 30, sem gravar", async () => {
    const { svc, repo, publish, run } = setup({ countActive: vi.fn().mockResolvedValue(5) });
    const err = await run(() => svc.create("c1", { bytes: OFX }, {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(30);
    expect(repo.insertQueued).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("falha ao publicar: loga só ids, não lança", async () => {
    const { svc, publish, logger, run } = setup();
    publish.mockRejectedValue(new Error("redis"));
    const out = await run(() => svc.create("c1", { bytes: OFX, originalName: "segredo.ofx" }, {}));
    expect(out.created).toBe(true);
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls[0]?.[0], (_k, v: unknown) =>
      v instanceof Error ? v.message : v,
    );
    expect(logged).toContain(JOB);
    expect(logged).not.toContain("segredo");
  });
});

describe("ImportsService.get e list", () => {
  it("get: id malformado ou ausente → NotFoundError", async () => {
    const { svc, repo, run } = setup({ get: vi.fn().mockResolvedValue(null) });
    await expect(run(() => svc.get("c1", "x"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run(() => svc.get("c1", JOB))).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.get).toHaveBeenCalledTimes(1);
  });

  it("list: valida limit e cursor; devolve nextCursor só se há mais", async () => {
    const list = vi.fn().mockResolvedValue({ items: [view], hasMore: true, last: JOB });
    const { svc, run } = setup({ list });
    await expect(run(() => svc.list("c1", { limit: 0 }))).rejects.toBeInstanceOf(ValidationError);
    await expect(run(() => svc.list("c1", { after: "!!" }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    const page = await run(() => svc.list("c1", { limit: 1 }));
    expect(page.nextCursor).not.toBeNull();
    const next = await run(() => svc.list("c1", { after: page.nextCursor as string }));
    expect(next.items).toHaveLength(1);
    expect(list).toHaveBeenLastCalledWith(20, JOB);
    list.mockResolvedValue({ items: [], hasMore: false });
    expect((await run(() => svc.list("c1"))).nextCursor).toBeNull();
  });
});
