/**
 * Caminho REAL de log: nestjs-pino (o mesmo LoggerModule do app) escrevendo num stream em memória,
 * com o Logger estático do Nest apontado para ele (`app.useLogger`). Prova que o erro do provedor
 * chega ao log com `err.message` e `err.stack` (o serializador do pino só trata `err` no topo do
 * objeto de log), e que o erro lançado ao chamador continua genérico.
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { Logger as NestLogger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Logger, LoggerModule } from "nestjs-pino";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelsConfig } from "../../core/config/models-config.js";
import { AllProvidersFailedError } from "../../core/errors/domain-errors.js";
import { MockResponderRegistry } from "./mock-models.js";
import { type LlmEnv, ModelFactory } from "./model-factory.js";

const SECRET_KEY = "or-key-NUNCA-NO-LOG";
const PROVIDER_TEXT = "texto interno do provedor 500";

const ENV: LlmEnv = {
  LLM_MODE: "live",
  OPENROUTER_API_KEY: SECRET_KEY,
  GROQ_API_KEY: undefined,
  NVIDIA_API_KEY: "nv-key-NUNCA-NO-LOG",
  OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
  GROQ_BASE_URL: "https://api.groq.com/openai/v1",
  NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1",
};

const CONFIG: ModelsConfig = {
  roles: {
    conversational: { primary: "openrouter/a:free", fallback: ["openrouter/b:free"] },
    reasoning: { primary: "openrouter/a:free", fallback: [] },
  },
  embeddings: { primary: "nvidia/nv-embedqa-e5-v5", dimensions: 1024 },
  limits: { rpm: 20, timeoutMs: 1000, temperature: 0.2 },
};

class FailingModel extends BaseChatModel {
  constructor(private readonly fail: boolean) {
    super({});
  }
  _llmType(): string {
    return "fake";
  }
  async _generate(): Promise<ChatResult> {
    if (this.fail) throw Object.assign(new Error(PROVIDER_TEXT), { status: 500 });
    return { generations: [{ text: "ok", message: new AIMessage("ok") }] };
  }
}

describe("logs do ModelFactory pelo nestjs-pino real", () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      cb();
    },
  });
  let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>["compile"]>>;
  let nestApp: ReturnType<typeof app.createNestApplication>;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { stream, level: "info" } })],
    }).compile();
    nestApp = app.createNestApplication();
    await nestApp.init();
    NestLogger.overrideLogger(nestApp.get(Logger));
  });
  afterAll(async () => {
    NestLogger.overrideLogger(["error", "warn", "log"]);
    await nestApp.close();
  });

  const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  function factory(redisEval: () => Promise<unknown>) {
    return new ModelFactory(
      ENV,
      CONFIG,
      { eval: redisEval as never },
      () => 1_000_000,
      new MockResponderRegistry(),
      {
        modelBuilder: (spec) => new FailingModel(spec.raw === "openrouter/a:free"),
      },
    );
  }

  it("falha de provedor: a linha do pino traz err.message, err.stack, provider e model", async () => {
    lines.length = 0;
    const f = factory(async () => 0);
    // Cadeia: a (falha 500) → b (ok): a falha é logada, a resposta vem do b.
    await f.chat("conversational").invoke([new HumanMessage("oi")]);
    const rec = records().find((r) => r["model"] === "openrouter/a:free");
    expect(rec).toBeDefined();
    const err = rec?.["err"] as { message?: unknown; stack?: unknown; type?: unknown };
    expect(typeof err.message).toBe("string");
    expect(err.message).toContain(PROVIDER_TEXT);
    expect(typeof err.stack).toBe("string");
    expect(rec?.["provider"]).toBe("openrouter");
    expect(typeof rec?.["msg"]).toBe("string");
    expect(rec?.["msg"]).not.toBe("");
    expect(lines.join("\n")).not.toContain(SECRET_KEY);
    expect(lines.join("\n")).not.toContain("NUNCA-NO-LOG");
  });

  it("cadeia toda falhando: o erro lançado segue genérico e o log traz a causa com stack", async () => {
    lines.length = 0;
    const f = new ModelFactory(
      ENV,
      CONFIG,
      { eval: (async () => 0) as never },
      () => 1_000_000,
      new MockResponderRegistry(),
      { modelBuilder: () => new FailingModel(true) },
    );
    const thrown = await f
      .chat("conversational")
      .invoke([new HumanMessage("oi")])
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(AllProvidersFailedError);
    expect((thrown as Error).message).toBe(new AllProvidersFailedError().message);
    expect((thrown as Error).message).not.toContain(PROVIDER_TEXT);
    const withErr = records().filter((r) => r["err"]);
    expect(withErr).toHaveLength(2);
    for (const r of withErr) {
      const err = r["err"] as { message: string; stack: string };
      expect(err.message).toContain(PROVIDER_TEXT);
      expect(err.stack).toContain("Error");
    }
  });

  it("limitador fail-open (Redis fora): a linha traz err.message, err.stack e provider", async () => {
    lines.length = 0;
    const down = vi.fn().mockRejectedValue(new Error("ECONNREFUSED redis"));
    const f = factory(down);
    await f
      .chat("reasoning")
      .invoke([new HumanMessage("oi")])
      .catch(() => undefined);
    const rec = records().find((r) => String(r["msg"]).includes("Limitador"));
    expect(rec).toBeDefined();
    const err = rec?.["err"] as { message?: string; stack?: unknown };
    expect(err.message).toContain("ECONNREFUSED");
    expect(typeof err.stack).toBe("string");
    expect(rec?.["provider"]).toBe("openrouter");
  });
});
