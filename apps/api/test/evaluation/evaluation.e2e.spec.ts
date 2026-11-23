/**
 * Rotas /api/eval/*: escopo `eval:run`, catálogo sem gabarito, correção determinística e cobrança
 * `evaluation` (R$ 5,00) uma vez por submissão corrigida; 422 nunca cobra; respostas e gabarito
 * nunca vão para o log. Redis: DB lógico próprio (test/setup/redis-dbs.ts), esvaziado a cada teste.
 */
import { Writable } from "node:stream";
import { EvalReportSchema, EvalCaseViewSchema, UsageSummarySchema } from "@carina/shared";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LoggingModule } from "../../src/core/logging/logging.module.js";
import { BillingModule } from "../../src/modules/billing/billing.module.js";
import { EVAL_DATASET } from "../../src/modules/evaluation/dataset.js";
import { EvaluationModule } from "../../src/modules/evaluation/evaluation.module.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("evaluation/evaluation.e2e.spec.ts");

/**
 * Chaves que só existem no gabarito (ou que o carregariam): nunca podem aparecer no catálogo nem no
 * relatório. `matched`/`missing` eram as listas de descrições do Python.
 */
const FORBIDDEN_KEYS = new Set([
  "expectedFacts",
  "forbidden",
  "reference",
  "alternatives",
  "matched",
  "missing",
]);

/** Todo texto do gabarito: descrições de fatos esperados e proibidos, e referências. */
const ANSWER_KEY_TEXTS: readonly string[] = EVAL_DATASET.flatMap((c) => [
  c.reference,
  ...c.expectedFacts.map((f) => f.description),
  ...c.forbidden.map((f) => f.description),
]);

/** Todas as strings (chaves e valores) do JSON, recursivamente. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allStrings(v, out);
    }
  }
  return out;
}

/** Nenhuma chave de gabarito e nenhum texto do gabarito, em nenhuma string do corpo. */
function expectNoAnswerKey(body: unknown): void {
  expect(findForbiddenKey(body)).toBeUndefined();
  const strings = allStrings(body);
  for (const text of ANSWER_KEY_TEXTS) {
    const hit = strings.find((s) => s.includes(text));
    expect(hit, `"${text}" vazou`).toBeUndefined();
  }
}

function findForbiddenKey(value: unknown, path = "$"): string | undefined {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = findForbiddenKey(v, `${path}[${String(i)}]`);
      if (hit) return hit;
    }
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) return `${path}.${k}`;
      const hit = findForbiddenKey(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe("Evaluation E2E", () => {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      cb();
    },
  });
  const ctx: {
    t?: TestApp;
    A?: SeededTenant;
    server?: Parameters<typeof request>[0];
    redis?: Redis;
  } = {};

  beforeAll(async () => {
    ctx.t = await createTestApp({
      imports: [LoggingModule.forRoot({ destination }), EvaluationModule, BillingModule],
      redisDb: REDIS_DB,
      env: { LOG_LEVEL: "info" },
    });
    ctx.server = ctx.t.app.getHttpServer() as Parameters<typeof request>[0];
    ctx.A = await ctx.t.seedTenant({ name: "Avaliação" });
    ctx.redis = new Redis(redisDbUrl(REDIS_DB));
  });
  afterAll(async () => {
    await ctx.redis?.quit();
    await ctx.t?.close();
  });
  beforeEach(async () => {
    await ctx.redis?.flushdb();
    lines.length = 0;
  });

  const key = () => (ctx.A as SeededTenant).keys.eval;
  const get = (path: string, k?: string) =>
    request(ctx.server as Parameters<typeof request>[0])
      .get(path)
      .set(k ? { Authorization: `Bearer ${k}` } : {});
  const post = (path: string, body: unknown, k?: string) =>
    request(ctx.server as Parameters<typeof request>[0])
      .post(path)
      .set(k ? { Authorization: `Bearer ${k}` } : {})
      .send(body as object);
  const evaluations = async (): Promise<{ count: number; totalBrl: string }> => {
    const res = await get("/api/usage", (ctx.A as SeededTenant).keys.chat);
    return UsageSummarySchema.parse(res.body).byWorkType.evaluation ?? { count: 0, totalBrl: "" };
  };

  it("sem eval:run → 403 problem+json, sem cobrança", async () => {
    const before = (await evaluations()).count;
    const chat = (ctx.A as SeededTenant).keys.chat;
    const res = await get("/api/eval/cases", chat);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const sub = await post(
      "/api/eval/submit",
      { answers: { "acoes-isencao-20k": "isento" } },
      chat,
    );
    expect(sub.status).toBe(403);
    expect((await evaluations()).count).toBe(before);
  });

  it("sem chave → 401", async () => {
    await get("/api/eval/cases").expect(401);
  });

  it("catálogo traz 42 casos sem gabarito (busca recursiva por chaves proibidas)", async () => {
    const before = (await evaluations()).count;
    const res = await get("/api/eval/cases", key()).expect(200);
    const cases = (res.body as unknown[]).map((c) => EvalCaseViewSchema.parse(c));
    expect(cases).toHaveLength(42);
    expect(findForbiddenKey(res.body)).toBeUndefined();
    // Nenhum texto de referência ou fato esperado vaza, em nenhuma chave.
    const raw = JSON.stringify(res.body);
    for (const c of EVAL_DATASET) expect(raw).not.toContain(c.reference);
    expect((await evaluations()).count).toBe(before);
  });

  it("catálogo filtra por categoria", async () => {
    const res = await get("/api/eval/cases?category=cvm", key()).expect(200);
    const cases = (res.body as unknown[]).map((c) => EvalCaseViewSchema.parse(c));
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.category === "cvm")).toBe(true);
  });

  it("categoria inválida → 422", async () => {
    const before = (await evaluations()).count;
    const res = await get("/api/eval/cases?category=astrologia", key());
    expect(res.status).toBe(422);
    expect((await evaluations()).count).toBe(before);
  });

  it("submit corrige, agrega e cobra uma vez (usage evaluation 5.00)", async () => {
    const before = await evaluations();
    const res = await post(
      "/api/eval/submit",
      {
        answers: {
          "acoes-isencao-20k": "Sim, é isento: vendas até R$ 20.000 por mês não pagam IR.",
          "acoes-aliquota-swing": "A alíquota é de 15%, mas 27,5% se aplica ao day trade.",
        },
      },
      key(),
    );
    expect(res.status).toBe(200);
    const report = EvalReportSchema.parse(res.body);
    expect(report.usage).toEqual({ workType: "evaluation", priceBrl: "5.00" });
    expect(report.answered).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.passRate).toBe(0.5);
    expect(report.results.map((r) => r.caseId)).toEqual([
      "acoes-aliquota-swing",
      "acoes-isencao-20k",
    ]);
    expect(report.results[0]?.forbiddenHits).toBe(1);
    expect(report.results[0]?.factsTotal).toBe(1);
    expect(report.results[0]?.factsMatched).toBe(1);
    const after = await evaluations();
    expect(after.count).toBe(before.count + 1);
    expect(Number(after.totalBrl) - Number(before.totalBrl)).toBe(5);
  });

  it("caso inexistente → 422 sem cobrança", async () => {
    const before = (await evaluations()).count;
    const res = await post(
      "/api/eval/submit",
      { answers: { "acoes-isencao-20k": "isento 20.000", "nao-existe": "x" } },
      key(),
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("nao-existe");
    expect((await evaluations()).count).toBe(before);
  });

  it("43 respostas ou resposta > 20 000 → 422 sem cobrança", async () => {
    const before = (await evaluations()).count;
    const many = Object.fromEntries(
      Array.from({ length: 43 }, (_, i) => [`caso-${String(i)}`, "x"]),
    );
    await post("/api/eval/submit", { answers: many }, key()).expect(422);
    await post(
      "/api/eval/submit",
      { answers: { "acoes-isencao-20k": "x".repeat(20_001) } },
      key(),
    ).expect(422);
    await post("/api/eval/submit", { answers: {} }, key()).expect(422);
    await post("/api/eval/submit", {}, key()).expect(422);
    expect((await evaluations()).count).toBe(before);
  });

  it("relatório não vaza gabarito: tudo errado (42 × 'x') e tudo certo", async () => {
    const wrong = Object.fromEntries(EVAL_DATASET.map((c) => [c.id, "x"]));
    const res1 = await post("/api/eval/submit", { answers: wrong }, key()).expect(200);
    const r1 = EvalReportSchema.parse(res1.body);
    expect(r1.answered).toBe(42);
    expect(r1.passed).toBe(0);
    expectNoAnswerKey(res1.body);

    // Resposta "certa": a primeira alternativa de cada fato esperado, nada proibido.
    const right = Object.fromEntries(
      EVAL_DATASET.map((c) => [c.id, c.expectedFacts.map((f) => f.alternatives[0]).join(" ; ")]),
    );
    const res2 = await post("/api/eval/submit", { answers: right }, key()).expect(200);
    const r2 = EvalReportSchema.parse(res2.body);
    expect(r2.answered).toBe(42);
    expect(r2.results.every((r) => r.factsMatched === r.factsTotal)).toBe(true);
    expectNoAnswerKey(res2.body);
  });

  it("id de ~100 KB → 422 com detail curto (o id não volta no erro), sem cobrança", async () => {
    const before = (await evaluations()).count;
    const huge = "a".repeat(100_000);
    const res = await post("/api/eval/submit", { answers: { [huge]: "x" } }, key());
    expect(res.status).toBe(422);
    const detail = (res.body as { detail?: string }).detail ?? "";
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.length).toBeLessThan(1024);
    expect(JSON.stringify(res.body).length).toBeLessThan(2048);
    expect((await evaluations()).count).toBe(before);
  });

  it("mais de 10 ids inexistentes: a mensagem lista 10 e diz quantos faltam", async () => {
    const answers = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`nao-existe-${String(i).padStart(2, "0")}`, "x"]),
    );
    const res = await post("/api/eval/submit", { answers }, key());
    expect(res.status).toBe(422);
    const detail = (res.body as { detail: string }).detail;
    expect(detail).toContain("nao-existe-09");
    expect(detail).not.toContain("nao-existe-10");
    expect(detail).toContain("e mais 5");
  });

  it("chave __proto__ → 422 (não é descartada em silêncio), sem cobrança", async () => {
    const before = (await evaluations()).count;
    const res = await request(ctx.server as Parameters<typeof request>[0])
      .post("/api/eval/submit")
      .set({ Authorization: `Bearer ${key()}`, "Content-Type": "application/json" })
      .send('{"answers":{"__proto__":"x","acoes-isencao-20k":"isento até R$ 20.000"}}');
    expect(res.status).toBe(422);
    expect((await evaluations()).count).toBe(before);
  });

  describe("cota mensal", () => {
    const usageOf = async (t: SeededTenant): Promise<number> => {
      const res = await get("/api/usage", t.keys.chat).expect(200);
      return UsageSummarySchema.parse(res.body).byWorkType.evaluation?.count ?? 0;
    };
    const ok = { answers: { "acoes-isencao-20k": "isento até R$ 20.000 por mês" } };

    it("cota 1: a primeira submissão passa, a segunda → 429 com Retry-After, 1 cobrança só", async () => {
      const T = await (ctx.t as TestApp).seedTenant({ name: "Cota eval", monthlyQuota: 1 });
      await post("/api/eval/submit", ok, T.keys.eval).expect(200);
      const res = await post("/api/eval/submit", ok, T.keys.eval);
      expect(res.status).toBe(429);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      expect(await usageOf(T)).toBe(1);
    });

    it("cota 1: um 422 não gasta a cota; a submissão válida seguinte → 200", async () => {
      const T = await (ctx.t as TestApp).seedTenant({ name: "Cota eval 422", monthlyQuota: 1 });
      await post("/api/eval/submit", { answers: { "nao-existe": "x" } }, T.keys.eval).expect(422);
      await post("/api/eval/submit", ok, T.keys.eval).expect(200);
      expect(await usageOf(T)).toBe(1);
    });
  });

  it("nenhum log contém o texto das respostas", async () => {
    const secret = "RESPOSTA-SECRETA-do-cliente-9f3a isento 20.000";
    const bad = "TEXTO-DE-RESPOSTA-INVALIDA-77b1";
    await post("/api/eval/submit", { answers: { "acoes-isencao-20k": secret } }, key()).expect(200);
    await post("/api/eval/submit", { answers: { "id-inexistente": bad } }, key()).expect(422);
    await get("/api/eval/cases", key()).expect(200);
    // O pino-http escreve a linha da requisição quando a resposta termina; dá um respiro.
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).not.toContain("RESPOSTA-SECRETA");
    expect(all).not.toContain(bad);
    for (const c of EVAL_DATASET) expect(all).not.toContain(c.reference);
  });
});
