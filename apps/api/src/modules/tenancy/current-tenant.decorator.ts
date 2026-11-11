import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { UnauthenticatedError } from "../../core/errors/domain-errors.js";
import type { AuthTenant, AuthenticatedRequest } from "./api-key.guard.js";

/** O AuthTenant preenchido pelo ApiKeyGuard; falha fechada (401) se faltar (ex.: rota @Public()). */
export function currentTenantFrom(ctx: ExecutionContext): AuthTenant {
  const tenant = ctx.switchToHttp().getRequest<AuthenticatedRequest>().tenant;
  if (!tenant) throw new UnauthenticatedError("Chave de API ausente ou inválida");
  return tenant;
}

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  currentTenantFrom(ctx),
);
