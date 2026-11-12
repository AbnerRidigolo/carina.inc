/**
 * Limitador por provedor de LLM: janela deslizante de 60 s no Redis, chave `llm:rl:<provedor>`,
 * limite `limits.rpm` do models.yaml (compartilhado por todas as instâncias do app). Reaproveita o
 * `slidingWindowAcquire` dos limites por tenant (mesmo script Lua).
 *
 * Cheio → `ProviderRateLimitedError`, que o `withFallbacks` trata como falha: a cadeia pula para o
 * próximo modelo sem gastar uma chamada que voltaria 429.
 *
 * Redis fora do ar → falha ABERTA (loga e deixa a chamada seguir). O limitador é só uma cortesia
 * com a cota do provedor, que continua aplicando o próprio limite; o pior caso é um 429 de
 * verdade, que a cadeia já trata. Falhar fechado transformaria um soluço do Redis em 503 para todo
 * chat. (O limite por tenant, no RateLimitGuard, continua falhando fechado.)
 */
import type { Redis } from "ioredis";
import { type RunnableConfig, Runnable } from "@langchain/core/runnables";
import type { Clock } from "../limits/clock.js";
import { slidingWindowAcquire } from "../limits/sliding-window.lua.js";

export const PROVIDER_WINDOW_MS = 60_000;

/**
 * Campos de uma linha de log. Forma de OBJETO no 1º argumento (o Logger do Nest com nestjs-pino faz
 * `Object.assign` dele no registro do pino): assim `err` fica no topo e o serializador do pino
 * guarda tipo, mensagem e stack. Um `Error` aninhado em outro objeto (ou como "contexto") perde tudo
 * menos as propriedades enumeráveis. Nunca colocar chaves de API, cabeçalhos nem prompts aqui.
 */
export interface LogFields {
  msg: string;
  err?: unknown;
  [field: string]: unknown;
}

export interface LlmLogger {
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

export class ProviderRateLimitedError extends Error {
  constructor(
    readonly provider: string,
    readonly retryAfterMs: number,
  ) {
    super(`Limite local por minuto do provedor ${provider} atingido`);
    this.name = "ProviderRateLimitedError";
  }
}

export class ProviderLimiter {
  constructor(
    private readonly redis: Pick<Redis, "eval">,
    private readonly rpm: number,
    private readonly clock: Clock,
    private readonly logger: LlmLogger,
  ) {}

  /** Reserva uma chamada ao provedor; `ProviderRateLimitedError` se a janela estiver cheia. */
  async acquire(provider: string): Promise<void> {
    let result;
    try {
      result = await slidingWindowAcquire(
        this.redis,
        `llm:rl:${provider}`,
        this.rpm,
        PROVIDER_WINDOW_MS,
        this.clock(),
      );
    } catch (err) {
      this.logger.warn({
        msg: "Limitador de LLM indisponível; seguindo sem limite local",
        provider,
        err,
      });
      return;
    }
    if (!result.allowed) {
      // O score do ZSET é o relógio de quem chamou: com relógios defasados entre instâncias, um
      // membro "do futuro" pode dar retry maior que a janela. Limitamos à janela (o membro sai no
      // máximo quando o relógio desta instância o alcançar; aceitamos essa imprecisão em troca de
      // não depender do TIME do Redis).
      throw new ProviderRateLimitedError(
        provider,
        Math.min(result.retryAfterMs, PROVIDER_WINDOW_MS),
      );
    }
  }
}

export interface LimitedFields<I, O> {
  inner: Runnable<I, O>;
  provider: string;
  model: string;
  limiter: ProviderLimiter;
  logger: LlmLogger;
}

/**
 * Um elo da cadeia: reserva a vaga no limitador do provedor e só então chama o modelo. Toda falha
 * é logada aqui (com o erro original e sua stack), porque o `withFallbacks` descarta os erros dos
 * elos depois do primeiro.
 */
export class LimitedRunnable<I, O> extends Runnable<I, O> {
  lc_namespace = ["carina", "llm"];
  private readonly f: LimitedFields<I, O>;

  constructor(fields: LimitedFields<I, O>) {
    super();
    this.f = fields;
  }

  private logFailure(err: unknown): void {
    const { provider, model } = this.f;
    if (err instanceof ProviderRateLimitedError) {
      this.f.logger.warn({
        msg: "Provedor de LLM no limite local; pulando para o próximo da cadeia",
        provider,
        model,
        retryAfterMs: err.retryAfterMs,
      });
      return;
    }
    this.f.logger.warn({
      msg: "Provedor de LLM falhou; tentando o próximo da cadeia",
      provider,
      model,
      err,
    });
  }

  async invoke(input: I, options?: Partial<RunnableConfig>): Promise<O> {
    try {
      await this.f.limiter.acquire(this.f.provider);
      return await this.f.inner.invoke(input, options);
    } catch (err) {
      this.logFailure(err);
      throw err;
    }
  }

  override async *_streamIterator(input: I, options?: Partial<RunnableConfig>): AsyncGenerator<O> {
    try {
      await this.f.limiter.acquire(this.f.provider);
      for await (const chunk of await this.f.inner.stream(input, options)) yield chunk;
    } catch (err) {
      this.logFailure(err);
      throw err;
    }
  }
}

export function limited<I, O>(fields: LimitedFields<I, O>): LimitedRunnable<I, O> {
  return new LimitedRunnable(fields);
}
