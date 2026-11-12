import { SetMetadata } from "@nestjs/common";

/** Escopos de uma chave de API. */
export const SCOPES = ["chat", "inbox:decide", "data:write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

export const REQUIRED_SCOPES_KEY = "carina:required-scopes";
export const REQUIRED_ANY_SCOPES_KEY = "carina:required-any-scopes";
export const IS_PUBLIC_KEY = "carina:is-public";

/**
 * A chave precisa ter TODOS os escopos listados; senão o ApiKeyGuard lança ForbiddenScopeError
 * (403). Vale no método ou no controller (o do método tem precedência).
 */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes);

/**
 * A chave precisa ter AO MENOS UM dos escopos listados (OU). Combina com `@RequireScopes` (E): ambas
 * as regras valem. Lista vazia nunca autoriza: o ApiKeyGuard nega (403). No método ou no controller.
 */
export const RequireAnyScope = (...scopes: Scope[]) => SetMetadata(REQUIRED_ANY_SCOPES_KEY, scopes);

/** Rota sem autenticação: o ApiKeyGuard não exige chave e não há TenantContext. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
