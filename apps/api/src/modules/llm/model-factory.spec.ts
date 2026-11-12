import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { RunnableLambda, RunnableWithFallbacks } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Env } from "../../core/config/env.js";
import type { ModelsConfig } from "../../core/config/models-config.js";
import { AllProvidersFailedError, ValidationError } from "../../core/errors/domain-errors.js";
import { HashEmbeddings } from "./hash-embeddings.js";
import { MockChatModel, MockResponderRegistry } from "./mock-models.js";
import {
  groqSdkBaseUrl,
  type LlmEnv,
  type ModelBuilder,
  ModelFactory,
  type ModelFactoryOptions,
  NvidiaEmbeddings,
  parseModelSpec,
} from "./model-factory.js";
import { ProviderLimiter, ProviderRateLimitedError } from "./provider-limiter.js";

// ── Dublês ──────────────────────────────────────────────────────────────────

/** Modelo falso: `behave` devolve o texto ou lança. Registra quantas vezes foi chamado. */
class FakeChatModel extends BaseChatModel {
  calls = 0;
  constructor(
    readonly id: string,
    private readonly behave: (messages: BaseMessage[]) => string,
  ) {
    super({});
  }
  _llmType(): string {
    return "fake";
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls++;
    const text = this.behave(messages);
    return { generations: [{ text, message: new AIMessage(text) }] };
  }
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** Redis falso que implementa o script da janela deslizante em memória (mesmos ARGV). */
function fakeRedis() {
  const zsets = new Map<string, number[]>();
  return {
    eval: vi.fn(async (...args: unknown[]) => {
      const [, , key, now, window, limit] = args as [
        string,
        number,
        string,
        string,
        string,
        string,
      ];
      const t = Number(now);
      const w = Number(window);
      const kept = (zsets.get(key) ?? []).filter((s) => s > t - w);
      if (kept.length < Number(limit)) {
        kept.push(t);
        zsets.set(key, kept);
        return 0;
      }
      zsets.set(key, kept);
      return Math.max(1, Math.min(...kept) + w - t);
    }),
  };
}

const LIVE_ENV: LlmEnv = {
  LLM_MODE: "live",
  OPENROUTER_API_KEY: "or-test-key",
  GROQ_API_KEY: "groq-test-key",
  NVIDIA_API_KEY: "nv-test-key",
  OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
  GROQ_BASE_URL: "https://api.groq.com/openai/v1",
  NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1",
};
const MOCK_ENV: LlmEnv = { ...LIVE_ENV, LLM_MODE: "mock" };

function config(over: Partial<ModelsConfig["limits"]> = {}): ModelsConfig {
  return {
    roles: {
      conversational: {
        primary: "openrouter/a:free",
        fallback: ["openrouter/b:free", "groq/c"],
      },
      reasoning: { primary: "openrouter/r1:free", fallback: ["groq/r2"] },
    },
    embeddings: { primary: "nvidia/nv-embedqa-e5-v5", dimensions: 1024 },
    limits: { rpm: 20, timeoutMs: 1000, temperature: 0.2, ...over },
  };
}

const silentLogger = () => ({ warn: vi.fn(), error: vi.fn() });

interface Setup {
  env?: LlmEnv;
  cfg?: ModelsConfig;
  models: Record<string, FakeChatModel>;
  redis?: ReturnType<typeof fakeRedis>;
  now?: () => number;
  registry?: MockResponderRegistry;
}

const reasoningFakes: Record<string, FakeChatModel> = {
  "openrouter/r1:free": new FakeChatModel("r1", () => "r1"),
  "groq/r2": new FakeChatModel("r2", () => "r2"),
};

function makeFactory(s: Setup) {
  const logger = silentLogger();
  const builder: ModelBuilder = vi.fn((spec) => {
    // O papel "reasoning" também é montado na construção: fakes padrão para ele.
    const m = s.models[spec.raw] ?? reasoningFakes[spec.raw];
    if (!m) throw new Error(`sem fake para ${spec.raw}`);
    return m;
  });
  const opts: ModelFactoryOptions = { modelBuilder: builder, logger };
  const factory = new ModelFactory(
    s.env ?? LIVE_ENV,
    s.cfg ?? config(),
    s.redis ?? fakeRedis(),
    s.now ?? (() => 1_000_000),
    s.registry ?? new MockResponderRegistry(),
    opts,
  );
  return { factory, logger, builder };
}

const msgs = [new HumanMessage("oi")];

/** `maxRetries` do AsyncCaller é protected: lido por cast só para afirmar a configuração. */
const maxRetriesOf = (m: { caller: unknown }): number =>
  (m.caller as { maxRetries: number }).maxRetries;

afterEach(() => vi.restoreAllMocks());

// ── Cadeia de fallback ──────────────────────────────────────────────────────

describe("ModelFactory.chat (live, cadeia de fallback)", () => {
  it("primário com 429 → a resposta vem do próximo modelo da cadeia, na ordem do models.yaml", async () => {
    const a = new FakeChatModel("a", () => {
      throw httpError(429, "429 Too Many Requests");
    });
    const b = new FakeChatModel("b", () => "resposta do b");
    const c = new FakeChatModel("c", () => "resposta do c");
    const { factory } = makeFactory({
      models: { "openrouter/a:free": a, "openrouter/b:free": b, "groq/c": c },
    });

    const out = await factory.chat("conversational").invoke(msgs);
    expect((out as AIMessage).content).toBe("resposta do b");
    expect([a.calls, b.calls, c.calls]).toEqual([1, 1, 0]);
  });

  it("todos falham → AllProvidersFailedError com mensagem genérica (sem texto do provedor) e erros logados", async () => {
    const leak = "sk-or-v1-SEGREDO texto interno do provedor";
    const fail = (id: string) =>
      new FakeChatModel(id, () => {
        throw httpError(500, `${leak} (${id})`);
      });
    const { factory, logger } = makeFactory({
      models: {
        "openrouter/a:free": fail("a"),
        "openrouter/b:free": fail("b"),
        "groq/c": fail("c"),
      },
    });

    const err = await factory
      .chat("conversational")
      .invoke(msgs)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    const e = err as AllProvidersFailedError;
    expect(e.message).toBe(new AllProvidersFailedError().message);
    expect(e.message).not.toContain("SEGREDO");
    expect(e.retryAfterSeconds).toBe(30);
    expect(JSON.stringify(e)).not.toContain("SEGREDO");
    expect((e as { cause?: unknown }).cause).toBeUndefined();
    // Cada falha de provedor é logada (com o erro original, que traz a stack).
    const logged = logger.warn.mock.calls.map((c) => c[1]);
    expect(logged).toHaveLength(3);
    for (const l of logged) expect((l as { err: Error }).err.stack).toContain("SEGREDO");
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("streaming: falha do primário antes do 1º pedaço cai no próximo modelo", async () => {
    const a = new FakeChatModel("a", () => {
      throw httpError(429, "429");
    });
    const b = new FakeChatModel("b", () => "via stream");
    const { factory } = makeFactory({
      models: {
        "openrouter/a:free": a,
        "openrouter/b:free": b,
        "groq/c": new FakeChatModel("c", () => "c"),
      },
    });
    let text = "";
    for await (const chunk of await factory.chat("conversational").stream(msgs)) {
      text += String((chunk as AIMessageChunk).content);
    }
    expect(text).toBe("via stream");
  });

  it("streaming: cadeia toda falhando também vira AllProvidersFailedError", async () => {
    const fail = (id: string) =>
      new FakeChatModel(id, () => {
        throw httpError(503, "upstream SEGREDO");
      });
    const { factory } = makeFactory({
      models: {
        "openrouter/a:free": fail("a"),
        "openrouter/b:free": fail("b"),
        "groq/c": fail("c"),
      },
    });
    const run = async () => {
      for await (const _ of await factory.chat("conversational").stream(msgs)) void _;
    };
    await expect(run()).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it("limitador com rpm 2: a 3ª chamada pula todos os modelos do provedor cheio e vai ao próximo", async () => {
    const a = new FakeChatModel("a", () => "a");
    const b = new FakeChatModel("b", () => "b");
    const c = new FakeChatModel("c", () => "c");
    const redis = fakeRedis();
    const { factory } = makeFactory({
      cfg: config({ rpm: 2 }),
      redis,
      models: { "openrouter/a:free": a, "openrouter/b:free": b, "groq/c": c },
    });
    const chain = factory.chat("conversational");
    const outs: unknown[] = [];
    for (let i = 0; i < 3; i++) outs.push(((await chain.invoke(msgs)) as AIMessage).content);
    expect(outs).toEqual(["a", "a", "c"]);
    expect([a.calls, b.calls, c.calls]).toEqual([2, 0, 1]);
    const keys = redis.eval.mock.calls.map((call) => call[2]);
    expect(keys).toContain("llm:rl:openrouter");
    expect(keys).toContain("llm:rl:groq");
  });

  it("schema e tools são aplicados a CADA modelo antes do withFallbacks", async () => {
    const schema = z.object({ answer: z.string() });
    const a = new FakeChatModel("a", () => "x");
    const b = new FakeChatModel("b", () => "x");
    const c = new FakeChatModel("c", () => "x");
    const order: string[] = [];
    const structured = (m: FakeChatModel, behave: () => unknown) =>
      vi.spyOn(m, "withStructuredOutput").mockImplementation(((s: unknown) => {
        expect(s).toBe(schema);
        order.push(`structured:${m.id}`);
        return RunnableLambda.from(behave);
      }) as never);
    structured(a, () => {
      throw httpError(429, "429");
    });
    structured(b, () => ({ answer: "do b" }));
    structured(c, () => ({ answer: "do c" }));
    const { factory } = makeFactory({
      models: { "openrouter/a:free": a, "openrouter/b:free": b, "groq/c": c },
    });

    const out = await factory.chat("conversational", { schema }).invoke(msgs);
    expect(out).toEqual({ answer: "do b" });
    expect(order).toEqual(["structured:a", "structured:b", "structured:c"]);
    // Por isso a ordem: o RunnableWithFallbacks devolvido por withFallbacks() não expõe nenhum
    // dos dois métodos (verificado no @langchain/core instalado).
    const fb = RunnableLambda.from(() => 1).withFallbacks([]);
    expect(fb).toBeInstanceOf(RunnableWithFallbacks);
    expect("withStructuredOutput" in fb).toBe(false);
    expect("bindTools" in fb).toBe(false);

    const echo = tool(async () => "ok", {
      name: "echo",
      description: "eco",
      schema: z.object({ q: z.string() }),
    });
    const bound: string[] = [];
    for (const m of [a, b, c]) {
      m.bindTools = vi.fn((tools: unknown[]) => {
        expect(tools).toEqual([echo]);
        bound.push(m.id);
        return RunnableLambda.from(() => new AIMessage(`tools:${m.id}`));
      }) as never;
    }
    const toolOut = await factory.chat("conversational", { tools: [echo] }).invoke(msgs);
    expect((toolOut as AIMessage).content).toBe("tools:a");
    expect(bound).toEqual(["a", "b", "c"]);
  });

  it("schema e tools juntos são recusados", () => {
    const { factory } = makeFactory({
      models: {
        "openrouter/a:free": new FakeChatModel("a", () => ""),
        "openrouter/b:free": new FakeChatModel("b", () => ""),
        "groq/c": new FakeChatModel("c", () => ""),
      },
    });
    const echo = tool(async () => "ok", { name: "e", description: "e", schema: z.object({}) });
    expect(() => factory.chat("reasoning", { schema: z.object({}), tools: [echo] })).toThrow(
      /schema.*tools/,
    );
  });
});

// ── Chaves e construção (live) ──────────────────────────────────────────────

describe("ModelFactory (live, chaves)", () => {
  const fakes = () => ({
    "openrouter/a:free": new FakeChatModel("a", () => "a"),
    "openrouter/b:free": new FakeChatModel("b", () => "b"),
    "groq/c": new FakeChatModel("c", () => "c"),
    "openrouter/r1:free": new FakeChatModel("r1", () => "r1"),
    "groq/r2": new FakeChatModel("r2", () => "r2"),
  });

  it("provedor sem chave sai da cadeia (com aviso, sem logar chaves)", async () => {
    const env = { ...LIVE_ENV, GROQ_API_KEY: undefined };
    const models = fakes();
    models["openrouter/a:free"] = new FakeChatModel("a", () => {
      throw httpError(429, "429");
    });
    models["openrouter/b:free"] = new FakeChatModel("b", () => {
      throw httpError(429, "429");
    });
    const { factory, logger, builder } = makeFactory({ env, models });
    await expect(factory.chat("conversational").invoke(msgs)).rejects.toBeInstanceOf(
      AllProvidersFailedError,
    );
    expect(models["groq/c"]?.calls).toBe(0);
    expect(vi.mocked(builder).mock.calls.map((c) => c[0].raw)).not.toContain("groq/c");
    const warned = JSON.stringify(logger.warn.mock.calls);
    expect(warned).toContain("GROQ_API_KEY");
    expect(warned).not.toContain("or-test-key");
    expect(warned).not.toContain("nv-test-key");
  });

  it("cadeia vazia por falta de chave falha na construção, nomeando a variável", () => {
    const cfg = config();
    cfg.roles.reasoning = { primary: "groq/r2", fallback: [] };
    expect(() =>
      makeFactory({ env: { ...LIVE_ENV, GROQ_API_KEY: undefined }, cfg, models: fakes() }),
    ).toThrow(/reasoning.*GROQ_API_KEY/);
  });

  it("embeddings sem NVIDIA_API_KEY no modo live falham na construção", () => {
    expect(() =>
      makeFactory({ env: { ...LIVE_ENV, NVIDIA_API_KEY: undefined }, models: fakes() }),
    ).toThrow(/NVIDIA_API_KEY/);
  });

  it("provedor desconhecido no models.yaml falha na construção", () => {
    const cfg = config();
    cfg.roles.reasoning = { primary: "anthropic/x", fallback: [] };
    expect(() => makeFactory({ cfg, models: fakes() })).toThrow(/anthropic/);
  });

  it("construtor padrão: ChatOpenAI (OpenRouter) e ChatGroq com maxRetries 0, timeout e temperatura do config", () => {
    const factory = new ModelFactory(
      LIVE_ENV,
      config(),
      fakeRedis(),
      () => 0,
      new MockResponderRegistry(),
      { logger: silentLogger() },
    );
    const models = factory.chainModels("conversational");
    expect(models.map((m) => m.spec.raw)).toEqual([
      "openrouter/a:free",
      "openrouter/b:free",
      "groq/c",
    ]);
    const [or, , groq] = models.map((m) => m.model);
    expect(or).toBeInstanceOf(ChatOpenAI);
    const orm = or as ChatOpenAI;
    expect(orm.model).toBe("a:free");
    expect(orm.temperature).toBe(0.2);
    expect(orm.timeout).toBe(1000);
    expect(orm.clientConfig.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(maxRetriesOf(orm)).toBe(0);
    expect(groq).toBeInstanceOf(ChatGroq);
    const gm = groq as ChatGroq;
    expect(gm.model).toBe("c");
    expect(maxRetriesOf(gm)).toBe(0);
    expect(factory.embeddings()).toBeInstanceOf(OpenAIEmbeddings);
    const e = factory.embeddings() as OpenAIEmbeddings;
    expect(e.dimensions).toBe(1024);
    expect(e.model).toBe("nv-embedqa-e5-v5");
  });
});

// ── Modo mock ───────────────────────────────────────────────────────────────

describe("ModelFactory (mock)", () => {
  it("nunca constrói cliente real e usa HashEmbeddings", () => {
    const { factory, builder } = makeFactory({ env: MOCK_ENV, models: {} });
    expect(factory.chat("conversational")).toBeInstanceOf(MockChatModel);
    expect(factory.embeddings()).toBeInstanceOf(HashEmbeddings);
    expect(builder).not.toHaveBeenCalled();
  });

  it("modo mock não exige chave nenhuma", () => {
    const env: LlmEnv = { ...MOCK_ENV, OPENROUTER_API_KEY: undefined, NVIDIA_API_KEY: undefined };
    const { factory } = makeFactory({ env, models: {} });
    expect(factory.chat("reasoning")).toBeInstanceOf(MockChatModel);
  });

  it("sem responder registrado devolve um placeholder determinístico", async () => {
    const { factory } = makeFactory({ env: MOCK_ENV, models: {} });
    const a = (await factory.chat("conversational").invoke(msgs)) as AIMessage;
    const b = (await factory.chat("conversational").invoke(msgs)) as AIMessage;
    expect(typeof a.content).toBe("string");
    expect(a.content).not.toBe("");
    expect(a.content).toBe(b.content);
  });

  it("usa o responder registrado para o mockKey (mockKey padrão = papel)", async () => {
    const registry = new MockResponderRegistry();
    registry.register("reasoning", () => "padrão do papel");
    registry.register("k", ({ mockKey, messages }) => `${mockKey}:${String(messages[0]?.content)}`);
    const { factory } = makeFactory({ env: MOCK_ENV, models: {}, registry });
    expect(((await factory.chat("reasoning").invoke(msgs)) as AIMessage).content).toBe(
      "padrão do papel",
    );
    expect(
      ((await factory.chat("reasoning", { mockKey: "k" }).invoke(msgs)) as AIMessage).content,
    ).toBe("k:oi");
  });

  it("com schema, resposta válida do mock volta como objeto validado", async () => {
    const registry = new MockResponderRegistry();
    registry.register("k", () => ({ intent: "carteira", extra: 1 }));
    const { factory } = makeFactory({ env: MOCK_ENV, models: {}, registry });
    const schema = z.object({ intent: z.string() });
    expect(await factory.chat("reasoning", { schema, mockKey: "k" }).invoke(msgs)).toEqual({
      intent: "carteira",
    });
  });

  it("com schema, resposta inválida do mock lança ValidationError", async () => {
    const registry = new MockResponderRegistry();
    registry.register("k", () => ({ intent: 42 }));
    registry.register("txt", () => "não é json");
    const { factory } = makeFactory({ env: MOCK_ENV, models: {}, registry });
    const schema = z.object({ intent: z.string() });
    await expect(
      factory.chat("reasoning", { schema, mockKey: "k" }).invoke(msgs),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      factory.chat("reasoning", { schema, mockKey: "txt" }).invoke(msgs),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("streaming divide o texto em pedaços de 12 caracteres", async () => {
    const registry = new MockResponderRegistry();
    const text = "abcdefghijklmnopqrstuvwxyz0123456789-fim";
    registry.register("s", () => text);
    const { factory } = makeFactory({ env: MOCK_ENV, models: {}, registry });
    const chunks: string[] = [];
    for await (const c of await factory.chat("conversational", { mockKey: "s" }).stream(msgs)) {
      chunks.push(String((c as AIMessageChunk).content));
    }
    expect(chunks.join("")).toBe(text);
    expect(chunks.slice(0, -1).every((c) => c.length === 12)).toBe(true);
    expect(chunks).toHaveLength(Math.ceil(text.length / 12));
  });

  it("responder com tool_calls vira AIMessage com tool_calls", async () => {
    const registry = new MockResponderRegistry();
    registry.register("t", () => ({
      content: "",
      tool_calls: [{ id: "1", name: "echo", args: { q: "x" } }],
    }));
    const { factory } = makeFactory({ env: MOCK_ENV, models: {}, registry });
    const out = (await factory.chat("conversational", { mockKey: "t" }).invoke(msgs)) as AIMessage;
    expect(out.tool_calls?.[0]).toMatchObject({ name: "echo", args: { q: "x" } });
  });
});

// ── Utilitários ─────────────────────────────────────────────────────────────

describe("utilitários", () => {
  it("parseModelSpec usa o prefixo antes da 1ª barra como provedor", () => {
    expect(parseModelSpec("openrouter/openai/gpt-oss-120b:free")).toEqual({
      raw: "openrouter/openai/gpt-oss-120b:free",
      provider: "openrouter",
      model: "openai/gpt-oss-120b:free",
    });
    expect(parseModelSpec("nvidia_nim/meta/llama").provider).toBe("nvidia");
    expect(parseModelSpec("nvidia/nv-embedqa-e5-v5").provider).toBe("nvidia");
    expect(() => parseModelSpec("semprefixo")).toThrow(/semprefixo/);
  });

  it("groqSdkBaseUrl tira o /openai/v1 (o groq-sdk já o acrescenta)", () => {
    expect(groqSdkBaseUrl("https://api.groq.com/openai/v1")).toBe("https://api.groq.com");
    expect(groqSdkBaseUrl("https://api.groq.com/openai/v1/")).toBe("https://api.groq.com");
    expect(groqSdkBaseUrl("https://proxy.local")).toBe("https://proxy.local");
  });

  it("NvidiaEmbeddings manda input_type query/passage", async () => {
    const spy = vi
      .spyOn(OpenAIEmbeddings.prototype, "embeddingWithRetry")
      .mockResolvedValue({ data: [{ embedding: [1] }] } as never);
    const e = new NvidiaEmbeddings({
      apiKey: "x",
      model: "nv-embedqa-e5-v5",
      configuration: { baseURL: "https://example.invalid/v1" },
    });
    await e.embedQuery("q");
    await e.embedDocuments(["d"]);
    const sent = spy.mock.calls.map((c) => (c[0] as { input_type?: string }).input_type);
    expect(sent).toEqual(["query", "passage"]);
  });

  it("ProviderLimiter falha aberto se o Redis cair (loga e deixa a chamada seguir)", async () => {
    const logger = silentLogger();
    const limiter = new ProviderLimiter(
      { eval: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) },
      2,
      () => 0,
      logger,
    );
    await expect(limiter.acquire("openrouter")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("ProviderLimiter cheio lança ProviderRateLimitedError com retry limitado à janela", async () => {
    // Retry acima da janela (ex.: relógio de outra instância adiantado) é limitado a 60 s.
    const limiter = new ProviderLimiter(
      { eval: vi.fn().mockResolvedValue(500_000) },
      2,
      () => 0,
      silentLogger(),
    );
    const err = await limiter.acquire("groq").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    expect((err as ProviderRateLimitedError).retryAfterMs).toBe(60_000);
    expect((err as ProviderRateLimitedError).provider).toBe("groq");
  });
});

// Garante que o tipo Env do config continua compatível com o que a fábrica consome.
const _envCompat: (e: Env) => LlmEnv = (e) => e;
void _envCompat;
