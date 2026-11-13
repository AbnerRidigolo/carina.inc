/**
 * Tickets de WebSocket (spec §6.1): a chave de API nunca vai na URL do WebSocket.
 *
 * - `issue` (chamado por `POST /api/ws/ticket`, autenticado pela chave com escopo `chat`): gera 32
 *   bytes de `crypto.randomBytes` (256 bits, base64url de 43 caracteres) e grava em Redis
 *   `ws:ticket:<ticket>` o tenant autenticado (inclui `keyId` e escopos) e o cliente final ao qual a
 *   conexão fica presa, com TTL de 30 s (`SET … EX 30 NX`).
 * - `consume`: confere o formato ANTES do Redis e usa `GETDEL` (atômico): o ticket vale uma vez só,
 *   mesmo com duas conexões simultâneas; vencido, usado, malformado ou corrompido → `null`.
 *
 * O ticket e a chave nunca vão para log.
 */
import { randomBytes } from "node:crypto";
import { WS_TICKET_TTL_SECONDS, type WsTicket } from "@carina/shared";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { REDIS } from "../../core/redis/redis.tokens.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import type { ClientRef } from "../tenancy/clients.service.js";

export const WS_TICKET_PREFIX = "ws:ticket:";
const TICKET_BYTES = 32;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

const GrantSchema = z.object({
  tenant: z.object({
    keyId: z.uuid(),
    tenantId: z.uuid(),
    tenantName: z.string(),
    scopes: z.array(z.string()),
    rpm: z.number().int(),
    monthlyQuota: z.number().int(),
  }),
  client: z.object({ id: z.uuid(), externalId: z.string().min(1) }),
});

/** O que a conexão herda do ticket: o tenant autenticado e o cliente final, pela vida toda. */
export interface WsTicketGrant {
  tenant: AuthTenant;
  client: ClientRef;
}

@Injectable()
export class WsTicketService {
  constructor(@Inject(REDIS) private readonly redis: Pick<Redis, "set" | "getdel">) {}

  async issue(tenant: AuthTenant, client: ClientRef): Promise<WsTicket> {
    const ticket = randomBytes(TICKET_BYTES).toString("base64url");
    const grant: WsTicketGrant = {
      tenant: {
        keyId: tenant.keyId,
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        scopes: [...tenant.scopes],
        rpm: tenant.rpm,
        monthlyQuota: tenant.monthlyQuota,
      },
      client: { id: client.id, externalId: client.externalId },
    };
    const ok = await this.redis.set(
      `${WS_TICKET_PREFIX}${ticket}`,
      JSON.stringify(grant),
      "EX",
      WS_TICKET_TTL_SECONDS,
      "NX",
    );
    // 256 bits aleatórios: colisão não acontece na prática; se acontecer, não sobrescreve.
    if (ok !== "OK") throw new Error("Falha ao gravar o ticket de WebSocket");
    return { ticket, expiresInSeconds: WS_TICKET_TTL_SECONDS };
  }

  /** Consome o ticket (uso único). `null` se ausente, malformado, vencido, já usado ou corrompido. */
  async consume(ticket: unknown): Promise<WsTicketGrant | null> {
    if (typeof ticket !== "string" || !TICKET_RE.test(ticket)) return null;
    const raw = await this.redis.getdel(`${WS_TICKET_PREFIX}${ticket}`);
    if (raw === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = GrantSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }
}
