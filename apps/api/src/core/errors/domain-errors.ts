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
export class ApprovalConflictError extends DomainError {
  readonly code = "approval_conflict";
  readonly status = 409;
}
export class RateLimitedError extends DomainError {
  readonly code = "rate_limited";
  readonly status = 429;
}
export class QuotaExceededError extends DomainError {
  readonly code = "quota_exceeded";
  readonly status = 429;
}
export class AllProvidersFailedError extends DomainError {
  readonly code = "all_providers_failed";
  readonly status = 503;

  constructor(message = "Todos os provedores de LLM falharam") {
    super(message, 30);
  }
}
