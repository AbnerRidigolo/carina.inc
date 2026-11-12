/**
 * Inbox de aprovações (spec §6.2): solicitação idempotente, decisão travada e execução no máximo
 * uma vez.
 *
 * Tudo roda sob RLS (TenantPrismaService) com o tenant do TenantContext atual: a aprovação de
 * outro tenant é invisível e resolve como NotFoundError, igual a uma inexistente.
 *
 * ── Garantia de execução NO MÁXIMO UMA VEZ ───────────────────────────────────────────────────
 * Um executor tem efeito externo (corretora, banco) e não cabe numa transação do banco. A ordem é:
 *   1. `INSERT executed_action(status='started') ON CONFLICT DO NOTHING`, numa transação própria
 *      que COMMITA antes de o executor rodar. A PK (approval_request_id) é a cerca: só quem
 *      inseriu executa; os demais recebem `skipped`. O INSERT só acontece se a aprovação está
 *      `approved` (rejeitada, pendente, vencida ou inexistente → nada inserido → `skipped`).
 *   2. O executor roda FORA de qualquer transação.
 *   3. O resultado vai para `executed_action` e, no sucesso, cobrança (`usage_record`) e auditoria
 *      (`audit_event`) entram na MESMA transação do status `succeeded`.
 *   4. `approval.executed` é publicado só depois do commit (melhor esforço).
 *
 * Onde uma queda deixa uma linha em `started`: depois do passo 1 e antes do passo 3 (o processo
 * morre, a leitura da aprovação falha, ou o executor trava). O efeito externo pode ou não ter
 * acontecido; não há como saber. A linha fica `started` e a ReconciliationJob a marca
 * `needs_review` depois de 5 min. NADA reexecuta uma linha existente, nem o job, nem outro
 * `executeOnce` (o INSERT conflita): reexecutar poderia duplicar uma ordem. Quem resolve é uma
 * pessoa.
 *
 * Falha no passo 3 (cobrança ou auditoria falham, ou o banco cai): a transação inteira desfaz
 * (status, cobrança e auditoria juntos), mas o efeito externo JÁ aconteceu. O desfecho honesto é
 * `needs_review`: numa transação separada a linha é marcada `needs_review` guardando o resultado
 * do executor (para o operador ver o que ocorreu), o erro é registrado e relançado. Se até essa
 * marcação falhar, a linha segue `started` e o job a promove a `needs_review`. Nunca `failed`
 * (o efeito aconteceu) e nunca `succeeded` sem cobrança.
 *
 * Eventos (`approval.created`, `resume`, `approval.executed`) saem sempre DEPOIS do commit e em
 * melhor esforço: a falha é registrada (só ids) e não desfaz o que o banco já confirmou. O banco é a
 * fonte da verdade; a ReconciliationJob republica `resume` de decisões confirmadas e não retomadas.
 * Nenhum payload (pode ter dados financeiros) vai para log: só ids e nome da ação.
 */
import { randomUUID } from "node:crypto";
import {
  AgentNameSchema,
  ApprovalViewSchema,
  MoneySchema,
  type ApprovalView,
  type DecisionRequest,
} from "@carina/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import {
  ApprovalConflictError,
  NotFoundError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { Prisma, type ApprovalRequest } from "../../generated/prisma/client.js";
import { BillingService } from "../billing/billing.service.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { ClientsService } from "../tenancy/clients.service.js";
import { WatchtowerService } from "../watchtower/watchtower.service.js";
import { approvalId } from "./approval-id.js";
import { ExecutorRegistry } from "./executors.js";
import { classifyRisk } from "./risk.js";

/** Forma de OBJETO no 1º argumento (nestjs-pino): `err` no topo; só ids, nunca payload. */
export interface InboxLogFields {
  msg: string;
  err?: unknown;
  [field: string]: unknown;
}

export interface InboxLogger {
  warn(fields: InboxLogFields): void;
  error(fields: InboxLogFields): void;
}

export const INBOX_LOGGER = Symbol("INBOX_LOGGER");

export const inboxLoggerProvider = {
  provide: INBOX_LOGGER,
  useFactory: (): InboxLogger => new Logger(InboxService.name),
};

export interface RequestInput {
  threadId: string;
  agent: string;
  action: string;
  payload: Record<string, unknown>;
  valueBrl: string;
}

export interface ExecuteResult {
  /** `needs_review`: o job já tinha marcado a linha; o resultado ficou só como evidência. */
  status: "succeeded" | "failed" | "skipped" | "needs_review";
  result?: unknown;
}

/** Linha de `executed_action` (estado real da execução de uma aprovação). */
export interface ExecutionView {
  status: "started" | "succeeded" | "failed" | "needs_review";
  /** Só no `succeeded` (o resultado de falhas pode conter a mensagem do executor). */
  result?: unknown;
}

const EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  "started",
  "succeeded",
  "failed",
  "needs_review",
]);

const HOUR_MS = 3_600_000;
const APPROVAL_ID_RE = /^[0-9a-f]{64}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 500;
const NOT_FOUND_MESSAGE = "Solicitação não encontrada";

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Erro interno: a linha `started` não está mais `started` (ex.: já virou needs_review). */
class ExecutionStateLostError extends Error {
  constructor() {
    super("executed_action deixou de estar em started antes de confirmar o resultado");
    this.name = "ExecutionStateLostError";
  }
}

interface LockedApproval {
  id: string;
  client_id: string;
  thread_id: string;
  status: string;
  expires_at: Date;
}

type DecideOutcome =
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "expired"; clientId: string; threadId: string }
  | { kind: "decided"; view: ApprovalView; clientId: string; threadId: string };

function toView(row: ApprovalRequest, clientExternalId: string): ApprovalView {
  return ApprovalViewSchema.parse({
    id: row.id,
    clientId: clientExternalId,
    agent: row.agent,
    action: row.action,
    risk: row.risk,
    payload: row.payload,
    valueBrl: row.valueBrl.toFixed(2),
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}

const errMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);

/** Valor de coluna Json: `undefined`/`null` viram JSON null. */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  const text = JSON.stringify(value);
  if (text === undefined) return Prisma.JsonNull;
  return JSON.parse(text) as Prisma.InputJsonValue;
}

@Injectable()
export class InboxService {
  constructor(
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(StreamsService) private readonly streams: StreamsService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(WatchtowerService) private readonly watchtower: WatchtowerService,
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(ExecutorRegistry) private readonly registry: ExecutorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Pick<Env, "APPROVAL_TTL_HOURS">,
    @Inject(INBOX_LOGGER) private readonly logger: InboxLogger,
  ) {}

  /**
   * Upsert idempotente da solicitação (id = hash(thread, ação, payload)): o nó executor roda de
   * novo ao retomar e não duplica. Roda sob o TenantContext do tenant E do cliente (o `threadId`
   * é `tenantId:clientId:uuid`). Só publica `approval.created` quando a linha foi criada agora.
   * `valueBrl` é validado ANTES de qualquer SQL (MoneySchema, não negativo): valor ruim → 422 e
   * nenhuma linha.
   */
  async request(input: RequestInput): Promise<{ approvalId: string; created: boolean }> {
    const { tenantId, clientId } = TenantContext.current();
    if (clientId === undefined) {
      throw new ValidationError("A solicitação precisa do cliente final no contexto");
    }
    const agent = AgentNameSchema.safeParse(input.agent);
    if (!agent.success) throw new ValidationError("agent inválido");
    if (
      typeof input.action !== "string" ||
      input.action.length === 0 ||
      input.action.length > 128
    ) {
      throw new ValidationError("action precisa ter de 1 a 128 caracteres");
    }
    if (
      typeof input.payload !== "object" ||
      input.payload === null ||
      Array.isArray(input.payload)
    ) {
      throw new ValidationError("payload precisa ser um objeto");
    }
    // O thread carrega tenant e cliente: impede que outro tenant forje o mesmo id (o hash inclui o
    // thread) e que o separador `|` da fórmula do id seja forjado por um thread malformado.
    const parts = typeof input.threadId === "string" ? input.threadId.split(":") : [];
    const [threadTenant, threadClient, threadRest] = parts;
    if (
      parts.length !== 3 ||
      threadTenant === undefined ||
      threadClient === undefined ||
      !sameId(threadTenant, tenantId) ||
      !sameId(threadClient, clientId) ||
      !threadRest ||
      threadRest.length > 128 ||
      threadRest.includes("|")
    ) {
      throw new ValidationError("threadId precisa ser tenantId:clientId:<id> do contexto atual");
    }
    if (
      typeof input.valueBrl !== "string" ||
      !MoneySchema.safeParse(input.valueBrl).success ||
      input.valueBrl.startsWith("-")
    ) {
      throw new ValidationError(
        "valueBrl precisa ser uma string decimal não negativa, com até 2 casas e no máximo 9999999999999999.99",
      );
    }
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(input.payload);
    } catch {
      throw new ValidationError("payload não é JSON válido");
    }
    if (payloadJson.length > MAX_PAYLOAD_BYTES || payloadJson.includes("\\u0000")) {
      throw new ValidationError("payload grande demais ou com caractere inválido");
    }

    const id = approvalId(input.threadId, input.action, input.payload);
    const risk = classifyRisk(input.action);
    const expiresAt = new Date(this.clock() + this.env.APPROVAL_TTL_HOURS * HOUR_MS).toISOString();

    const created = await this.db.tx(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO approval_request
          (id, tenant_id, client_id, thread_id, agent, action, risk, payload, value_brl, status, expires_at)
        VALUES
          (${id}, ${tenantId}::uuid, ${clientId}::uuid, ${input.threadId}, ${agent.data},
           ${input.action}, ${risk}, ${payloadJson}::jsonb, ${input.valueBrl}::numeric, 'pending',
           ${expiresAt}::timestamptz)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
      return rows.length > 0;
    });

    if (created) {
      try {
        await this.streams.publish("inbox.events", {
          eventId: randomUUID(),
          type: "approval.created",
          tenantId,
          clientId,
          approvalId: id,
        });
      } catch (err) {
        this.logger.error({
          msg: "Falha ao publicar approval.created; a solicitação foi gravada",
          err,
          tenantId,
          clientId,
          approvalId: id,
        });
      }
    }
    return { approvalId: id, created };
  }

  /** Pendentes e não vencidas do cliente (`externalId`), mais antigas primeiro. */
  async listPending(clientExternalId: string): Promise<ApprovalView[]> {
    const client = await this.clients.resolve(clientExternalId);
    const rows = await TenantContext.withClient(client.id, () =>
      this.db.client.approvalRequest.findMany({
        where: { status: "pending", expiresAt: { gt: new Date(this.clock()) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
    return rows.map((row) => toView(row, client.externalId));
  }

  /** A solicitação do tenant atual; de outro tenant, inexistente ou id malformado → NotFoundError. */
  async get(id: string): Promise<ApprovalView> {
    if (!APPROVAL_ID_RE.test(id)) throw new NotFoundError(NOT_FOUND_MESSAGE);
    const row = await this.db.client.approvalRequest.findUnique({
      where: { id },
      include: { client: { select: { externalId: true } } },
    });
    if (!row) throw new NotFoundError(NOT_FOUND_MESSAGE);
    return toView(row, row.client.externalId);
  }

  /**
   * Estado da execução de uma aprovação do tenant atual (`null` se ainda não há linha). Usado por
   * quem recebeu `skipped` do `executeOnce` para reportar o status real (outro worker executou).
   */
  async executionOf(id: string): Promise<ExecutionView | null> {
    if (!APPROVAL_ID_RE.test(id)) return null;
    const row = await this.db.client.executedAction.findUnique({
      where: { approvalRequestId: id },
      select: { status: true, result: true },
    });
    if (!row || !EXECUTION_STATUSES.has(row.status)) return null;
    const status = row.status as ExecutionView["status"];
    return status === "succeeded" ? { status, result: row.result } : { status };
  }

  /**
   * Vence a solicitação se ainda está `pending` e o prazo já passou pelo CLOCK (UPDATE condicional:
   * entre chamadas concorrentes só uma vence). Devolve se ESTA chamada a venceu. Não publica
   * `resume`: quem chama (o guard do `OrchestratorService.stream`) fecha a espera do thread na hora.
   */
  async expireIfDue(id: string): Promise<boolean> {
    if (!APPROVAL_ID_RE.test(id)) return false;
    const nowIso = new Date(this.clock()).toISOString();
    const rows = await this.db.tx(
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
        UPDATE approval_request SET status = 'expired'
        WHERE id = ${id} AND status = 'pending' AND expires_at <= ${nowIso}::timestamptz
        RETURNING id`,
    );
    return rows.length > 0;
  }

  /**
   * Decide uma solicitação pendente. Numa transação: `SELECT … FOR UPDATE` (a segunda decisão
   * concorrente espera e depois vê o status já decidido → conflito). Depois do commit, publica
   * `resume` em `jobs` (melhor esforço; a reconciliação republica decisões não retomadas).
   * Vencida: grava `expired` (a transação COMMITA, o erro sai depois) e lança conflito.
   */
  async decide(id: string, decision: DecisionRequest, by: AuthTenant): Promise<ApprovalView> {
    if (!APPROVAL_ID_RE.test(id)) throw new NotFoundError(NOT_FOUND_MESSAGE);
    const { tenantId } = TenantContext.current();

    const outcome = await this.db.tx(async (tx): Promise<DecideOutcome> => {
      const rows = await tx.$queryRaw<LockedApproval[]>`
        SELECT id, client_id, thread_id, status, expires_at
        FROM approval_request WHERE id = ${id} FOR UPDATE`;
      const locked = rows[0];
      if (!locked) return { kind: "not_found" };
      if (locked.status !== "pending") return { kind: "conflict" };

      const now = this.clock();
      if (locked.expires_at.getTime() <= now) {
        await tx.approvalRequest.update({ where: { id }, data: { status: "expired" } });
        return { kind: "expired", clientId: locked.client_id, threadId: locked.thread_id };
      }
      const updated = await tx.approvalRequest.update({
        where: { id },
        data: {
          status: decision.approved ? "approved" : "rejected",
          decidedByKeyId: by.keyId,
          decidedAt: new Date(now),
          reason: decision.reason ?? null,
        },
        include: { client: { select: { externalId: true } } },
      });
      return {
        kind: "decided",
        view: toView(updated, updated.client.externalId),
        clientId: locked.client_id,
        threadId: locked.thread_id,
      };
    });

    switch (outcome.kind) {
      case "not_found":
        throw new NotFoundError(NOT_FOUND_MESSAGE);
      case "conflict":
        throw new ApprovalConflictError("A solicitação já foi decidida");
      case "expired":
        // Ninguém mais vai retomar o grafo desta solicitação: avisa como rejeitada.
        await this.publishResume(tenantId, outcome.clientId, id, outcome.threadId, false);
        throw new ApprovalConflictError("A solicitação expirou");
      case "decided":
        await this.publishResume(
          tenantId,
          outcome.clientId,
          id,
          outcome.threadId,
          decision.approved,
        );
        return outcome.view;
    }
  }

  /**
   * Executa a ação aprovada no máximo uma vez (ver o cabeçalho do arquivo). Roda sob o
   * TenantContext do tenant (workers fixam o tenant do evento). Devolve `skipped` quando a
   * aprovação não está `approved` ou já foi (ou está sendo) executada.
   */
  async executeOnce(id: string): Promise<ExecuteResult> {
    const { tenantId } = TenantContext.current();
    if (!APPROVAL_ID_RE.test(id)) return { status: "skipped" };

    // 1. A cerca: COMMITA antes de o executor rodar.
    const startedAt = new Date(this.clock()).toISOString();
    const claimed = await this.db.tx(
      (tx) =>
        tx.$queryRaw<{ client_id: string }[]>`
        INSERT INTO executed_action (approval_request_id, tenant_id, client_id, status, started_at)
        SELECT a.id, a.tenant_id, a.client_id, 'started', ${startedAt}::timestamptz
        FROM approval_request a
        WHERE a.id = ${id} AND a.status = 'approved'
        ON CONFLICT DO NOTHING
        RETURNING client_id`,
    );
    const clientId = claimed[0]?.client_id;
    if (clientId === undefined) return { status: "skipped" };

    // Daqui em diante a linha está `started`: qualquer queda termina em needs_review (job).
    const approval = await this.db.client.approvalRequest.findUnique({ where: { id } });
    if (!approval) throw new Error("aprovação sumiu depois de reservada a execução");
    const payload = (approval.payload ?? {}) as Record<string, unknown>;
    const executor = this.registry.get(approval.action);

    // 2. Efeito externo, fora de qualquer transação.
    const t0 = performance.now();
    let result: unknown;
    let failure: unknown;
    let failed = false;
    try {
      if (!executor) throw new Error("Nenhum executor registrado para a ação");
      result = await TenantContext.withClient(clientId, () =>
        executor(payload, { tenantId, clientId, approvalId: id }),
      );
    } catch (err) {
      failed = true;
      failure = err;
    }
    const durationMs = Math.max(0, Math.round(performance.now() - t0));

    if (failed) {
      const confirmed = await this.db.tx(async (tx) => {
        const upd = await tx.executedAction.updateMany({
          where: { approvalRequestId: id, status: "started" },
          data: {
            status: "failed",
            result: { error: errMessage(failure) },
            finishedAt: new Date(this.clock()),
          },
        });
        return upd.count === 1;
      });
      if (confirmed) {
        await this.publishExecuted(tenantId, clientId, id, "failed");
        return { status: "failed" };
      }
      // A linha já saiu de `started` (o job a marcou needs_review): o estado real é needs_review.
      await this.recordLateEvidence(tenantId, clientId, id, approval.action, {
        error: errMessage(failure),
        note: "falhou após needs_review",
      });
      return { status: "needs_review" };
    }

    // 3. Sucesso: status + cobrança + auditoria na MESMA transação.
    try {
      await this.db.tx(async (tx) => {
        const upd = await tx.executedAction.updateMany({
          where: { approvalRequestId: id, status: "started" },
          data: {
            status: "succeeded",
            result: toJson(result),
            finishedAt: new Date(this.clock()),
          },
        });
        if (upd.count !== 1) throw new ExecutionStateLostError();
        await this.billing.record({
          tx,
          clientId,
          workType: "execution",
          agents: [approval.agent],
          valueBrl: approval.valueBrl,
          durationMs,
        });
        await this.watchtower.review({
          tx,
          clientId,
          channel: "worker",
          query: `execute:${approval.action}`,
          agents: [approval.agent],
          responseText: `Ação ${approval.action} executada (aprovação ${id})`,
          durationMs,
        });
      });
    } catch (err) {
      if (err instanceof ExecutionStateLostError) {
        // O job já marcou needs_review enquanto o executor rodava: nada a cobrar, mas o efeito
        // externo aconteceu, então o resultado é gravado como evidência (sem mudar o status).
        await this.recordLateEvidence(tenantId, clientId, id, approval.action, {
          executorResult: result ?? null,
          note: "concluiu após needs_review",
        });
        return { status: "needs_review", result };
      }
      // O efeito externo JÁ aconteceu e a transação desfez tudo: needs_review, com o resultado.
      await this.markNeedsReview(tenantId, clientId, id, approval.action, result, err);
      throw err;
    }

    await this.publishExecuted(tenantId, clientId, id, "succeeded");
    return { status: "succeeded", result };
  }

  /**
   * UPDATE só de evidência: guarda o desfecho do executor numa linha que já está `needs_review`
   * (ou ainda `started`) e sem resultado. Não muda o status, não cobra, não audita. Só o
   * `action` e ids vão para o log, nunca o payload.
   */
  private async recordLateEvidence(
    tenantId: string,
    clientId: string,
    id: string,
    action: string,
    evidence: Record<string, unknown>,
  ): Promise<void> {
    try {
      const count = await this.db.tx(async (tx) => {
        const upd = await tx.executedAction.updateMany({
          where: {
            approvalRequestId: id,
            status: { in: ["started", "needs_review"] },
            result: { equals: Prisma.DbNull },
          },
          data: { result: toJson(evidence) },
        });
        return upd.count;
      });
      this.logger.error({
        msg:
          count === 1
            ? "Executor concluiu depois de needs_review; desfecho gravado como evidência (sem cobrança)"
            : "Executor concluiu depois de needs_review e a linha já tem resultado; desfecho não gravado",
        tenantId,
        clientId,
        approvalId: id,
        action,
      });
    } catch (err) {
      this.logger.error({
        msg: "Executor concluiu depois de needs_review e a evidência não pôde ser gravada",
        err,
        tenantId,
        clientId,
        approvalId: id,
        action,
      });
    }
  }

  /** Melhor esforço: se falhar, a linha segue `started` e a reconciliação a promove. */
  private async markNeedsReview(
    tenantId: string,
    clientId: string,
    id: string,
    action: string,
    result: unknown,
    cause: unknown,
  ): Promise<void> {
    let marked = false;
    try {
      marked = await this.db.tx(async (tx) => {
        const upd = await tx.executedAction.updateMany({
          where: { approvalRequestId: id, status: "started" },
          data: {
            status: "needs_review",
            result: toJson({ executorResult: result ?? null, note: "efeito externo executado" }),
            finishedAt: new Date(this.clock()),
          },
        });
        return upd.count === 1;
      });
    } catch (err) {
      this.logger.error({
        msg: "Não foi possível marcar needs_review; a reconciliação fará isso",
        err,
        tenantId,
        clientId,
        approvalId: id,
      });
    }
    if (marked) {
      this.logger.error({
        msg: "Ação executada mas o registro do resultado falhou; marcada needs_review",
        err: cause,
        tenantId,
        clientId,
        approvalId: id,
        action,
      });
    } else {
      // A linha já saiu de `started` (job) ou a marcação falhou: guarda ao menos a evidência.
      await this.recordLateEvidence(tenantId, clientId, id, action, {
        executorResult: result ?? null,
        note: "concluiu após needs_review",
      });
    }
  }

  private async publishResume(
    tenantId: string,
    clientId: string,
    approvalId: string,
    threadId: string,
    approved: boolean,
  ): Promise<void> {
    await publishResume(this.streams, this.logger, {
      tenantId,
      clientId,
      approvalId,
      threadId,
      approved,
    });
  }

  private async publishExecuted(
    tenantId: string,
    clientId: string,
    approvalId: string,
    status: "succeeded" | "failed",
  ): Promise<void> {
    try {
      await this.streams.publish("inbox.events", {
        eventId: randomUUID(),
        type: "approval.executed",
        tenantId,
        clientId,
        approvalId,
        status,
      });
    } catch (err) {
      this.logger.error({
        msg: "Falha ao publicar approval.executed; a execução já está confirmada",
        err,
        tenantId,
        clientId,
        approvalId,
      });
    }
  }
}

/** `resume` em `jobs`, em melhor esforço (compartilhado com a ReconciliationJob). */
export async function publishResume(
  streams: StreamsService,
  logger: InboxLogger,
  e: {
    tenantId: string;
    clientId: string;
    approvalId: string;
    threadId: string;
    approved: boolean;
  },
): Promise<void> {
  try {
    await streams.publish("jobs", { eventId: randomUUID(), type: "resume", ...e });
  } catch (err) {
    logger.error({
      msg: "Falha ao publicar resume; a decisão está gravada e a reconciliação republica",
      err,
      tenantId: e.tenantId,
      clientId: e.clientId,
      approvalId: e.approvalId,
    });
  }
}
