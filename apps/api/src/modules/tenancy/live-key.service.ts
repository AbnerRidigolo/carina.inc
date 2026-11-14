/**
 * Revalidação de uma chave de API já autenticada, pelo id (`resolve_api_key_by_id`, SECURITY
 * DEFINER, o mesmo critério do `resolve_api_key` do ApiKeyGuard: chave não revogada de tenant não
 * suspenso). Para conexões longas (WebSocket do chat), que guardam só o `keyId` do ticket.
 *
 * Devolve o `AuthTenant` VIVO (escopos, rpm e cota atuais) ou `null`. O resultado (inclusive o
 * `null`) fica em cache por `API_KEY_REVALIDATE_TTL_MS` (no máximo 60 s, validado no Env): essa é a
 * janela MÁXIMA entre revogar a chave, tirar um escopo, suspender o tenant ou mudar o plano e o
 * efeito numa conexão aberta. Cache em memória por processo, limitado em tamanho.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { PrismaService } from "../../core/database/prisma.service.js";
import { type AuthTenant, type ResolvedKeyRow, toAuthTenant } from "./api-key.guard.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CACHE_ENTRIES = 10_000;

export const LIVE_KEY_CLOCK = Symbol("LIVE_KEY_CLOCK");

type KeyQuery = Pick<PrismaService, "$queryRaw">;

@Injectable()
export class LiveKeyService {
  private readonly cache = new Map<string, { expiresAt: number; tenant: AuthTenant | null }>();
  private readonly ttlMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: KeyQuery,
    @Inject(ENV) env: Pick<Env, "API_KEY_REVALIDATE_TTL_MS">,
    @Optional() @Inject(LIVE_KEY_CLOCK) private readonly now: () => number = Date.now,
  ) {
    this.ttlMs = env.API_KEY_REVALIDATE_TTL_MS;
  }

  /** A chave ativa (estado atual, com até `ttlMs` de atraso) ou `null`. */
  async resolve(keyId: string): Promise<AuthTenant | null> {
    if (!UUID_RE.test(keyId)) return null;
    const now = this.now();
    const hit = this.cache.get(keyId);
    if (hit && hit.expiresAt > now) return hit.tenant;

    const rows = await this.prisma.$queryRaw<ResolvedKeyRow[]>`
      SELECT key_id, tenant_id, tenant_name, scopes, rpm, monthly_quota
      FROM resolve_api_key_by_id(${keyId}::uuid)`;
    const tenant = rows[0] ? toAuthTenant(rows[0]) : null;
    if (this.ttlMs > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
      this.cache.set(keyId, { expiresAt: now + this.ttlMs, tenant });
    }
    return tenant;
  }
}
