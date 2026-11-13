/**
 * Watchtower: inspeciona a resposta de um agente e grava a trilha de auditoria.
 *
 * `audit_event` é só-INSERT para o carina_app (e roda sob RLS com o tenant do TenantContext): este
 * serviço nunca atualiza nem apaga. A trilha guarda o digest SHA-256 da resposta, nunca o texto;
 * as flags carregam só o tipo da PII ou o trecho mínimo que disparou certeza/recomendação.
 */
import { createHash } from "node:crypto";
import { ComplianceFlagSchema, type AuditEventView, type ComplianceFlag } from "@carina/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import type { AuditEvent, Prisma } from "../../generated/prisma/client.js";
import { inspectText } from "./inspect-text.js";

export const DEFAULT_TRAIL_LIMIT = 100;
export const MAX_TRAIL_LIMIT = 500;

export type AuditChannel = "rest" | "ws" | "worker";

export interface ReviewInput {
  /** Transação em curso: o evento entra nela e confirma/desfaz junto com o chamador. */
  tx?: Prisma.TransactionClient;
  /** Uuid interno do cliente final (não o externalId). */
  clientId?: string;
  channel: AuditChannel;
  query: string;
  agents: string[];
  responseText: string;
  durationMs: number;
}

export interface ReviewResult {
  auditId: string;
  flags: ComplianceFlag[];
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function toView(row: AuditEvent): AuditEventView {
  return {
    id: row.id,
    ...(row.clientId ? { clientId: row.clientId } : {}),
    channel: row.channel,
    query: row.query,
    agents: row.agents,
    flags: ComplianceFlagSchema.array().parse(row.flags),
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class WatchtowerService {
  private readonly log = new Logger(WatchtowerService.name);

  constructor(@Inject(TenantPrismaService) private readonly db: TenantPrismaService) {}

  /** Inspeciona `responseText` e grava o evento (INSERT; com `tx`, na transação do chamador). */
  async review(input: ReviewInput): Promise<ReviewResult> {
    // Sem contexto de tenant rejeita (UnauthenticatedError) sem tocar no banco.
    const { tenantId } = TenantContext.current();
    const flags = inspectText(input.responseText);

    const auditEvent = input.tx ? input.tx.auditEvent : this.db.client.auditEvent;
    const row = await auditEvent.create({
      data: {
        tenantId,
        clientId: input.clientId ?? null,
        channel: input.channel,
        query: input.query,
        agents: input.agents,
        responseDigest: sha256Hex(input.responseText),
        flags,
        durationMs: Math.max(0, Math.trunc(input.durationMs)),
      },
      select: { id: true },
    });

    // Só ids e códigos no log: nunca o texto da resposta nem a PII.
    if (flags.length > 0) {
      this.log.warn({
        msg: "watchtower.flags",
        auditId: row.id,
        codes: flags.map((f) => f.code),
      });
    } else {
      this.log.log({ msg: "watchtower.clean", auditId: row.id });
    }
    return { auditId: row.id, flags };
  }

  /** Trilha recente do tenant atual, mais novos primeiro. `limit` ≥ 1 (inteiro), no máximo 500. */
  async trail(limit: number = DEFAULT_TRAIL_LIMIT): Promise<AuditEventView[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError("limit precisa ser um inteiro maior ou igual a 1");
    }
    const rows = await this.db.client.auditEvent.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(limit, MAX_TRAIL_LIMIT),
    });
    return rows.map(toView);
  }
}
