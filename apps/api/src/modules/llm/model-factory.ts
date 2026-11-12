/**
 * Fábrica de modelos de LLM do CARINA.
 *
 * `chat(role, opts)` devolve um Runnable de mensagens com a cadeia de fallback do papel no
 * models.yaml (primário → fallbacks, na ordem do arquivo). Para cada modelo da cadeia:
 *   1. constrói o cliente (`ChatOpenAI` p/ OpenRouter, `ChatGroq` p/ Groq), com `maxRetries: 0`
 *      (um 429 cai no próximo modelo na hora, sem esperar retry) e timeout/temperatura do config;
 *   2. aplica `withStructuredOutput(schema)` ou `bindTools(tools)` NO MODELO, antes de encadear: o
 *      `RunnableWithFallbacks` devolvido por `withFallbacks()` não expõe nenhum dos dois métodos;
 *   3. envolve no limitador do provedor (`llm:rl:<provedor>`, `limits.rpm` por minuto).
 * Depois encadeia com `first.withFallbacks(rest)`. Cadeia inteira falhando vira
 * `AllProvidersFailedError` com mensagem FIXA: o texto dos erros de provedor só vai para o log,
 * nunca para a resposta HTTP (o filtro de Problem Details expõe a mensagem de erros de domínio 5xx).
 *
 * `LLM_MODE=mock`: devolve `MockChatModel` (sem cliente real e sem Redis) e `HashEmbeddings`.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseMessage } from "@langchain/core/messages";
import { Runnable, type RunnableConfig } from "@langchain/core/runnables";
import type { StructuredTool } from "@langchain/core/tools";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { ZodType } from "zod";
import { ENV, MODELS_CONFIG } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import type { ModelsConfig } from "../../core/config/models-config.js";
import { AllProvidersFailedError } from "../../core/errors/domain-errors.js";
import { REDIS } from "../../core/redis/redis.tokens.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { HashEmbeddings } from "./hash-embeddings.js";
import { MockChatModel, MockResponderRegistry, mockStructured } from "./mock-models.js";
import { type LlmLogger, ProviderLimiter, limited } from "./provider-limiter.js";

export type Role = "conversational" | "reasoning";

export type Provider = "openrouter" | "groq" | "nvidia";

/** Subconjunto do Env que a fábrica consome. */
export type LlmEnv = Pick<
  Env,
  | "LLM_MODE"
  | "OPENROUTER_API_KEY"
  | "GROQ_API_KEY"
  | "NVIDIA_API_KEY"
  | "OPENROUTER_BASE_URL"
  | "GROQ_BASE_URL"
  | "NVIDIA_BASE_URL"
>;

export interface ModelSpec {
  raw: string;
  provider: Provider;
  /** Id do modelo no provedor (tudo depois do 1º `/`). */
  model: string;
}

export interface ChatOptions {
  schema?: ZodType;
  tools?: StructuredTool[];
  /** Chave do responder no modo mock (padrão: o papel). */
  mockKey?: string;
}

/** Constrói o cliente de UM modelo da cadeia (injetável nos testes). */
export type ModelBuilder = (spec: ModelSpec) => BaseChatModel;

export const MODEL_FACTORY_OPTIONS = Symbol("MODEL_FACTORY_OPTIONS");

export interface ModelFactoryOptions {
  modelBuilder?: ModelBuilder;
  logger?: LlmLogger;
}

const ENV_VAR: Record<Provider, keyof LlmEnv> = {
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  nvidia: "NVIDIA_API_KEY",
};

const PREFIX_TO_PROVIDER: Record<string, Provider> = {
  openrouter: "openrouter",
  groq: "groq",
  nvidia: "nvidia",
  nvidia_nim: "nvidia",
};

/** `openrouter/openai/gpt-oss-120b:free` → provedor `openrouter`, modelo `openai/gpt-oss-120b:free`. */
export function parseModelSpec(raw: string): ModelSpec {
  const i = raw.indexOf("/");
  if (i <= 0 || i === raw.length - 1) {
    throw new Error(`Modelo "${raw}" no models.yaml deve ter a forma <provedor>/<modelo>`);
  }
  const prefix = raw.slice(0, i);
  const provider = PREFIX_TO_PROVIDER[prefix];
  if (!provider) {
    throw new Error(
      `Provedor "${prefix}" desconhecido em "${raw}" (aceitos: ${Object.keys(PREFIX_TO_PROVIDER).join(", ")})`,
    );
  }
  return { raw, provider, model: raw.slice(i + 1) };
}

/**
 * O `groq-sdk` acrescenta `/openai/v1/...` ao baseURL; o GROQ_BASE_URL do .env já o traz (formato
 * OpenAI-compatível). Tiramos o sufixo para não duplicar o caminho.
 */
export function groqSdkBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/openai\/v1$/, "");
}

/**
 * Embeddings da NVIDIA (NeMo Retriever): modelos assimétricos exigem `input_type`
 * (`query` / `passage`); `truncate: END` evita erro em textos acima do contexto do modelo.
 */
export class NvidiaEmbeddings extends OpenAIEmbeddings {
  constructor(fields: NonNullable<ConstructorParameters<typeof OpenAIEmbeddings>[0]>) {
    super({ batchSize: 32, ...fields });
  }

  private clean(text: string): string {
    return this.stripNewLines ? text.replace(/\n/g, " ") : text;
  }

  private params(input: string | string[], inputType: "query" | "passage") {
    const params: Record<string, unknown> = {
      model: this.model,
      input,
      input_type: inputType,
      truncate: "END",
    };
    if (this.dimensions) params["dimensions"] = this.dimensions;
    if (this.encodingFormat) params["encoding_format"] = this.encodingFormat;
    return params as unknown as Parameters<OpenAIEmbeddings["embeddingWithRetry"]>[0];
  }

  override async embedQuery(text: string): Promise<number[]> {
    const { data } = await this.embeddingWithRetry(this.params(this.clean(text), "query"));
    const first = data[0];
    if (!first) throw new Error("Resposta de embeddings vazia");
    return first.embedding;
  }

  override async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => this.clean(t));
      const { data } = await this.embeddingWithRetry(this.params(batch, "passage"));
      if (data.length !== batch.length) throw new Error("Resposta de embeddings incompleta");
      for (const d of data) out.push(d.embedding);
    }
    return out;
  }
}

/** Converte qualquer falha da cadeia em AllProvidersFailedError (mensagem fixa; erros já logados). */
class ChainFailureMapper<O> extends Runnable<BaseMessage[], O> {
  lc_namespace = ["carina", "llm"];

  constructor(
    private readonly chain: Runnable<BaseMessage[], O>,
    private readonly role: Role,
    private readonly logger: LlmLogger,
  ) {
    super();
  }

  private fail(): AllProvidersFailedError {
    this.logger.error("Todos os provedores de LLM falharam", { role: this.role });
    return new AllProvidersFailedError();
  }

  async invoke(input: BaseMessage[], options?: Partial<RunnableConfig>): Promise<O> {
    try {
      return await this.chain.invoke(input, options);
    } catch {
      // Os erros originais já foram logados (com stack) a cada elo, em LimitedRunnable.
      throw this.fail();
    }
  }

  override async *_streamIterator(
    input: BaseMessage[],
    options?: Partial<RunnableConfig>,
  ): AsyncGenerator<O> {
    try {
      for await (const chunk of await this.chain.stream(input, options)) yield chunk;
    } catch {
      throw this.fail();
    }
  }
}

@Injectable()
export class ModelFactory {
  private readonly logger: LlmLogger;
  private readonly buildModel: ModelBuilder;
  private readonly limiter: ProviderLimiter;
  private readonly chains = new Map<Role, { spec: ModelSpec; model: BaseChatModel }[]>();
  private readonly embeddingsImpl: EmbeddingsInterface;

  constructor(
    @Inject(ENV) private readonly env: LlmEnv,
    @Inject(MODELS_CONFIG) private readonly config: ModelsConfig,
    @Inject(REDIS) redis: Pick<Redis, "eval">,
    @Inject(CLOCK) clock: Clock,
    @Inject(MockResponderRegistry) private readonly registry: MockResponderRegistry,
    @Optional() @Inject(MODEL_FACTORY_OPTIONS) options: ModelFactoryOptions = {},
  ) {
    this.logger = options.logger ?? new Logger(ModelFactory.name);
    this.buildModel = options.modelBuilder ?? ((spec) => this.defaultBuilder(spec));
    this.limiter = new ProviderLimiter(redis, config.limits.rpm, clock, this.logger);

    if (env.LLM_MODE === "mock") {
      // Mock nunca constrói cliente real.
      this.embeddingsImpl = new HashEmbeddings(config.embeddings.dimensions);
      return;
    }
    // Live: monta (e valida) as cadeias já na construção, para falhar no boot e não na 1ª chamada.
    for (const role of ["conversational", "reasoning"] as const) {
      this.chains.set(role, this.buildChain(role));
    }
    this.embeddingsImpl = this.buildEmbeddings();
  }

  /** Modelos (já construídos) da cadeia do papel, na ordem de tentativa. Só no modo live. */
  chainModels(role: Role): { spec: ModelSpec; model: BaseChatModel }[] {
    return this.chains.get(role) ?? [];
  }

  chat(role: Role, opts: ChatOptions = {}): Runnable<BaseMessage[], unknown> {
    if (opts.schema && opts.tools) {
      throw new Error("chat(): use schema OU tools, não os dois ao mesmo tempo");
    }
    if (this.env.LLM_MODE === "mock") return this.mockChat(role, opts);

    const links = this.chainModels(role).map(({ spec, model }) => {
      let runnable: Runnable<BaseMessage[], unknown>;
      if (opts.schema) {
        runnable = model.withStructuredOutput(opts.schema) as Runnable<BaseMessage[], unknown>;
      } else if (opts.tools) {
        if (!model.bindTools) {
          throw new Error(`O modelo ${spec.raw} não suporta bindTools`);
        }
        runnable = model.bindTools(opts.tools) as Runnable<BaseMessage[], unknown>;
      } else {
        runnable = model as Runnable<BaseMessage[], unknown>;
      }
      return limited({
        inner: runnable,
        provider: spec.provider,
        model: spec.raw,
        limiter: this.limiter,
        logger: this.logger,
      });
    });
    const [first, ...rest] = links;
    if (!first) throw new Error(`Cadeia vazia para o papel ${role}`);
    return new ChainFailureMapper(first.withFallbacks(rest), role, this.logger);
  }

  embeddings(): EmbeddingsInterface {
    return this.embeddingsImpl;
  }

  private mockChat(role: Role, opts: ChatOptions): Runnable<BaseMessage[], unknown> {
    const mockKey = opts.mockKey ?? role;
    const model = new MockChatModel({ responder: this.registry.resolve(mockKey), mockKey });
    // A resolução é feita aqui (não por chamada): registrar o responder depois do chat() não vale.
    return opts.schema ? mockStructured(model, opts.schema) : model;
  }

  private buildChain(role: Role): { spec: ModelSpec; model: BaseChatModel }[] {
    const { primary, fallback } = this.config.roles[role];
    const specs = [primary, ...fallback].map(parseModelSpec);
    const chain: { spec: ModelSpec; model: BaseChatModel }[] = [];
    const missing = new Set<string>();
    for (const spec of specs) {
      const varName = ENV_VAR[spec.provider];
      if (!this.env[varName]) {
        missing.add(varName);
        this.logger.warn(`${varName} ausente: ${spec.raw} fora da cadeia de ${role}`);
        continue;
      }
      chain.push({ spec, model: this.buildModel(spec) });
    }
    if (chain.length === 0) {
      throw new Error(
        `Cadeia vazia para o papel ${role}: defina ${[...missing].join(" ou ")} (LLM_MODE=live)`,
      );
    }
    return chain;
  }

  private defaultBuilder(spec: ModelSpec): BaseChatModel {
    const { timeoutMs, temperature } = this.config.limits;
    switch (spec.provider) {
      case "openrouter":
        return new ChatOpenAI({
          model: spec.model,
          apiKey: this.env.OPENROUTER_API_KEY,
          configuration: { baseURL: this.env.OPENROUTER_BASE_URL },
          temperature,
          timeout: timeoutMs,
          maxRetries: 0,
        });
      case "groq":
        return new ChatGroq({
          model: spec.model,
          apiKey: this.env.GROQ_API_KEY,
          baseUrl: groqSdkBaseUrl(this.env.GROQ_BASE_URL),
          temperature,
          timeout: timeoutMs,
          maxRetries: 0,
        });
      case "nvidia":
        // Inferência na NVIDIA NIM é opcional (OpenAI-compatível); hoje o models.yaml só a usa
        // para embeddings.
        return new ChatOpenAI({
          model: spec.model,
          apiKey: this.env.NVIDIA_API_KEY,
          configuration: { baseURL: this.env.NVIDIA_BASE_URL },
          temperature,
          timeout: timeoutMs,
          maxRetries: 0,
        });
    }
  }

  private buildEmbeddings(): EmbeddingsInterface {
    if (!this.env.NVIDIA_API_KEY) {
      throw new Error("NVIDIA_API_KEY é obrigatória para embeddings com LLM_MODE=live");
    }
    const spec = parseModelSpec(this.config.embeddings.primary);
    return new NvidiaEmbeddings({
      model: spec.model,
      apiKey: this.env.NVIDIA_API_KEY,
      configuration: { baseURL: this.env.NVIDIA_BASE_URL },
      dimensions: this.config.embeddings.dimensions,
      timeout: this.config.limits.timeoutMs,
      maxRetries: 0,
    });
  }
}
