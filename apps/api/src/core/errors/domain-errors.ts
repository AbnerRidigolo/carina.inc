export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = new.target.name;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ValidationError extends DomainError {
  readonly code = "validation_error";
  readonly status = 422;
}
export class UnauthenticatedError extends DomainError {
  readonly code = "unauthenticated";
  readonly status = 401;
}
export class ForbiddenScopeError extends DomainError {
  readonly code = "forbidden_scope";
  readonly status = 403;
}
export class NotFoundError extends DomainError {
  readonly code = "not_found";
  readonly status = 404;
}
/** Corpo ou arquivo acima do limite aceito (ex.: upload de importação acima de 10 MB). */
export class PayloadTooLargeError extends DomainError {
  readonly code = "payload_too_large";
  readonly status = 413;
}
/** Conflito com o estado atual do recurso (ex.: disparo manual repetido no mesmo minuto). */
export class ConflictError extends DomainError {
  readonly code = "conflict";
  readonly status = 409;
}
export class ApprovalConflictError extends DomainError {
  readonly code = "approval_conflict";
  readonly status = 409;
}
/** Outro turno de chat está em andamento no mesmo thread (os turnos de um thread são em série). */
export class ThreadBusyError extends DomainError {
  readonly code = "thread_busy";
  readonly status = 409;
}
/** 429 sempre traz `Retry-After`: por isso o construtor exige `retryAfterSeconds`. */
export class RateLimitedError extends DomainError {
  readonly code = "rate_limited";
  readonly status = 429;

  // Não é inútil: torna `retryAfterSeconds` obrigatório (a base o deixa opcional).
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(message: string, retryAfterSeconds: number) {
    super(message, retryAfterSeconds);
  }
}
export class QuotaExceededError extends DomainError {
  readonly code = "quota_exceeded";
  readonly status = 429;

  // Não é inútil: torna `retryAfterSeconds` obrigatório (a base o deixa opcional).
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(message: string, retryAfterSeconds: number) {
    super(message, retryAfterSeconds);
  }
}
export class AllProvidersFailedError extends DomainError {
  readonly code = "all_providers_failed";
  readonly status = 503;

  constructor(message = "Todos os provedores de LLM falharam") {
    super(message, 30);
  }
}
/**
 * Provedor de mercado (brapi.dev, SGS do BCB) fora do ar ou com resposta inválida. A mensagem é
 * fixa e nunca carrega texto do provedor: o detalhe vai só para o log.
 */
export class MarketDataUnavailableError extends DomainError {
  readonly code = "market_data_unavailable";
  readonly status = 502;

  constructor() {
    super("Dados de mercado indisponíveis");
  }
}
/**
 * Orçamento global de chamadas ao provedor de mercado esgotado na janela de 1 minuto (protege a cota
 * do token único da brapi, dividida por todos os tenants). 503, não 429: o limite é da plataforma,
 * não do cliente. Sempre com `Retry-After` (segundos até a próxima janela) e mensagem fixa.
 */
export class MarketDataBusyError extends DomainError {
  readonly code = "market_data_busy";
  readonly status = 503;

  constructor(retryAfterSeconds: number) {
    super(
      "Limite de consultas ao provedor de mercado atingido; tente novamente em instantes",
      retryAfterSeconds,
    );
  }
}
