/**
 * Execução de um AOP para os clientes dele (spec §4.4). Roda sob o tenant já fixado pelo chamador
 * (`TenantContext.run`); cada cliente, em sequência, sob `TenantContext.withClient` (RLS):
 *
 *   1. resolve o externalId no tenant, sem criar: sumiu → `skipped/client_not_found`, sem cota nem
 *      cobrança. Não há linha em `aop_run` (o `client_id` é FK para `client`): fica no resumo e no
 *      log (só contagens);
 *   2. já há execução deste AOP, cliente e `fireAt` (reentrega do disparo manual, réplica) → nada
 *      roda, nada é reservado nem cobrado (`alreadyRan`);
 *   3. reserva 1 unidade da cota mensal (`QuotaService.reserve`, com a cota lida do tenant):
 *      esgotada → `skipped/quota_exceeded` deste e dos seguintes, sem tentar reservar de novo;
 *   4. `KnowledgeService.search(descrição)` (falha → conhecimento vazio, como no grafo do chat);
 *   5. os agentes em paralelo pelo `AgentRegistry`, com a pergunta `Execute o procedimento: …` (a
 *      descrição é DADO: o montador de mensagens do agente a isola numa mensagem `human` própria,
 *      nunca no system prompt); a falha de um vira `{ failed: true }`;
 *   6. todos falharam → `failed/agents_failed`, cota devolvida, sem cobrança nem auditoria;
 *   7. senão, numa transação: `usage_record` (`classifyWork(agentes)`, uuid interno do cliente),
 *      `audit_event` (Watchtower, canal `worker`, query `[AOP:<nome>] <descrição>`, resposta = os
 *      resultados serializados) e o `aop_run` `ok`. Se o `aop_run` já existia (corrida com outro
 *      worker), a transação é desfeita (cobrança e auditoria juntas) e a cota devolvida: uma
 *      reentrega nunca cobra duas vezes.
 * Um erro inesperado num cliente (busca do cliente, cobrança, banco) devolve a cota se reservada, é
 * logado e os demais seguem: um erro transitório no cliente k custa só o cliente k.
 *
 * Resultados guardados com o mesmo limite do chat: a saída do agente já vem validada (schema e
 * `refine`) e o texto livre cortado em `MAX_OUTPUT_CHARS`; aqui, por defesa, o texto é cortado de
 * novo e um valor que não serializa vira `{ failed: true }`.
 *
 * Logs só com ids e contagens: nunca a descrição, o nome do AOP, o externalId ou os resultados.
 */
import { AOP_MAX_CLIENTS, type Aop, type AopRun } from "@carina/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { QuotaExceededError } from "../../core/errors/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { MAX_OUTPUT_CHARS, agentFailure, isAgentFailure } from "../agents/agent.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { BillingService } from "../billing/billing.service.js";
import { classifyWork } from "../billing/pricing.js";
import { errorFields } from "../imports/import.worker.js";
import { KnowledgeService, type SearchResult } from "../knowledge/knowledge.service.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { QuotaService, type QuotaTenant } from "../limits/quota.service.js";
import { WatchtowerService } from "../watchtower/watchtower.service.js";
import { AopsRepository, type NewAopRun } from "./aops.repository.js";

type Tx = Prisma.TransactionClient;

/** Logger dos AOPs (runner e job), provido por `aopLoggerProvider`. */
export const AOP_LOGGER = Symbol("AOP_LOGGER");

/** Forma de OBJETO no 1º argumento (nestjs-pino). Só ids e contagens. */
export interface AopLogFields {
  msg: string;
  [field: string]: unknown;
}

export interface AopLogger {
  info(fields: AopLogFields): void;
  warn(fields: AopLogFields): void;
  error(fields: AopLogFields): void;
}

export const aopLoggerProvider = {
  provide: AOP_LOGGER,
  useFactory: (): AopLogger => {
    const logger = new Logger("Aops");
    return {
      info: (fields) => logger.log(fields),
      warn: (fields) => logger.warn(fields),
      error: (fields) => logger.error(fields),
    };
  },
};

export interface AopRunOptions {
  /** O horário agendado (`previousFire`) ou o instante do disparo manual. */
  fireAt: Date;
  trigger: AopRun["trigger"];
}

export type AopClientStatus = AopRun["status"] | "already_ran" | "error";

export interface AopClientOutcome {
  /** externalId do cliente (nunca vai para log). */
  clientId: string;
  status: AopClientStatus;
  failureCode: AopRun["failureCode"];
}

export interface AopRunSummary {
  ok: number;
  failed: number;
  /** inclui `client_not_found` (sem linha) e `quota_exceeded` */
  skipped: number;
  /** já executado neste `fireAt` (reentrega/réplica): nada rodou nem foi cobrado */
  alreadyRan: number;
  /** erro inesperado no cliente (cota devolvida, sem linha) */
  errors: number;
  clients: AopClientOutcome[];
}

const EMPTY_KNOWLEDGE: SearchResult = { chunks: [], entities: [], neighbors: [] };

/** A execução já estava gravada: desfaz a transação da cobrança. */
class AlreadyRanError extends Error {
  constructor() {
    super("Execução do AOP já gravada");
    this.name = "AlreadyRanError";
  }
}

/** Mesmo limite do chat para o que fica guardado (ver o topo). */
export function clampResult(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_OUTPUT_CHARS ? value.slice(0, MAX_OUTPUT_CHARS) : value;
  }
  try {
    return JSON.stringify(value) === undefined ? agentFailure() : value;
  } catch {
    return agentFailure();
  }
}

@Injectable()
export class AopRunner {
  constructor(
    @Inject(TenantPrismaService) private readonly db: Pick<TenantPrismaService, "tx">,
    @Inject(AopsRepository) private readonly repo: Pick<AopsRepository, "insertRun">,
    @Inject(AgentRegistry) private readonly agents: Pick<AgentRegistry, "get">,
    @Inject(KnowledgeService) private readonly knowledge: Pick<KnowledgeService, "search">,
    @Inject(QuotaService) private readonly quota: Pick<QuotaService, "reserve" | "refund">,
    @Inject(BillingService) private readonly billing: Pick<BillingService, "record">,
    @Inject(WatchtowerService) private readonly watchtower: Pick<WatchtowerService, "review">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AOP_LOGGER) private readonly logger: AopLogger,
  ) {}

  /** Executa o AOP para cada cliente (sequencial, até `AOP_MAX_CLIENTS`). */
  async run(aop: Aop, opts: AopRunOptions): Promise<AopRunSummary> {
    const { tenantId } = TenantContext.current();
    const quotaTenant = await this.quotaTenant(tenantId);
    const summary: AopRunSummary = {
      ok: 0,
      failed: 0,
      skipped: 0,
      alreadyRan: 0,
      errors: 0,
      clients: [],
    };
    let quotaExhausted = false;

    for (const externalId of aop.clientIds.slice(0, AOP_MAX_CLIENTS)) {
      // A busca do cliente fica DENTRO do try: um erro transitório nela custa só este cliente.
      let clientId: string | undefined;
      let outcome: Omit<AopClientOutcome, "clientId">;
      try {
        const client = await this.db.tx((tx) =>
          tx.client.findUnique({
            where: { tenantId_externalId: { tenantId, externalId } },
            select: { id: true },
          }),
        );
        if (client === null) {
          outcome = { status: "skipped", failureCode: "client_not_found" };
        } else {
          clientId = client.id;
          const id = client.id;
          outcome = await TenantContext.withClient(id, () =>
            this.runClient(aop, opts, id, quotaTenant, quotaExhausted),
          );
        }
      } catch (err) {
        this.logger.error({
          msg: "Execução do AOP falhou para o cliente",
          ...errorFields(err),
          tenantId,
          aopId: aop.id,
          ...(clientId === undefined ? {} : { clientId }),
        });
        outcome = { status: "error", failureCode: null };
      }
      if (outcome.failureCode === "quota_exceeded") quotaExhausted = true;
      summary.clients.push({ clientId: externalId, ...outcome });
      if (outcome.status === "ok") summary.ok++;
      else if (outcome.status === "failed") summary.failed++;
      else if (outcome.status === "skipped") summary.skipped++;
      else if (outcome.status === "already_ran") summary.alreadyRan++;
      else summary.errors++;
    }

    this.logger.info({
      msg: "AOP executado",
      tenantId,
      aopId: aop.id,
      trigger: opts.trigger,
      fireAt: opts.fireAt.toISOString(),
      ok: summary.ok,
      failed: summary.failed,
      skipped: summary.skipped,
      alreadyRan: summary.alreadyRan,
      errors: summary.errors,
    });
    return summary;
  }

  /** Cota mensal do tenant fixado (lida sob RLS: o tenant só enxerga a própria linha). */
  private async quotaTenant(tenantId: string): Promise<QuotaTenant> {
    const row = await this.db.tx((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { monthlyQuota: true } }),
    );
    if (row === null) throw new Error("Tenant do AOP não encontrado");
    return { tenantId, monthlyQuota: row.monthlyQuota };
  }

  /** Um cliente, sob o contexto dele. Erros inesperados sobem já com a cota devolvida. */
  private async runClient(
    aop: Aop,
    opts: AopRunOptions,
    clientId: string,
    quotaTenant: QuotaTenant,
    quotaExhausted: boolean,
  ): Promise<Omit<AopClientOutcome, "clientId">> {
    const base = { aopId: aop.id, clientId, fireAt: opts.fireAt, trigger: opts.trigger };
    const existing = await this.db.tx((tx) =>
      tx.aopRun.findFirst({
        where: { aopId: aop.id, clientId, fireAt: opts.fireAt },
        select: { id: true },
      }),
    );
    if (existing !== null) return { status: "already_ran", failureCode: null };

    const skipQuota = async () => {
      const row = await this.insertUnbilled({ ...base, status: "skipped" }, "quota_exceeded", {});
      return row ? { status: "skipped" as const, failureCode: "quota_exceeded" as const } : null;
    };
    if (quotaExhausted) return (await skipQuota()) ?? { status: "already_ran", failureCode: null };
    try {
      await this.quota.reserve(quotaTenant);
    } catch (err) {
      if (!(err instanceof QuotaExceededError)) throw err;
      return (await skipQuota()) ?? { status: "already_ran", failureCode: null };
    }

    let settled = false; // cota consumida (cobrado) ou já devolvida
    try {
      const started = this.clock();
      const ids = { tenantId: quotaTenant.tenantId, aopId: aop.id, clientId };
      const knowledge = await this.knowledge.search(aop.description).catch((err: unknown) => {
        this.logger.warn({ msg: "AOP: busca de conhecimento falhou", ...errorFields(err), ...ids });
        return EMPTY_KNOWLEDGE;
      });
      const question = `Execute o procedimento: ${aop.description}`;
      const outputs = await Promise.all(
        aop.agents.map(async (agent) => {
          try {
            const out = await this.agents.get(agent).run({ question, history: [], knowledge });
            return [agent, clampResult(out)] as const;
          } catch (err) {
            this.logger.warn({ msg: "AOP: agente falhou", ...errorFields(err), ...ids, agent });
            return [agent, agentFailure()] as const;
          }
        }),
      );
      const results: Record<string, unknown> = Object.fromEntries(outputs);
      const durationMs = Math.max(0, Math.round(this.clock() - started));

      if (outputs.every(([, out]) => isAgentFailure(out))) {
        await this.refund(quotaTenant, aop.id, clientId);
        settled = true;
        const row = await this.insertUnbilled(
          { ...base, status: "failed" },
          "agents_failed",
          results,
        );
        return row
          ? { status: "failed", failureCode: "agents_failed" }
          : { status: "already_ran", failureCode: null };
      }

      const agents = [...aop.agents];
      const workType = classifyWork(agents);
      try {
        await this.db.tx(async (tx) => {
          const record = await this.billing.record({ tx, clientId, workType, agents, durationMs });
          const review = await this.watchtower.review({
            tx,
            clientId,
            channel: "worker",
            query: `[AOP:${aop.name}] ${aop.description}`,
            agents,
            responseText: JSON.stringify(results),
            durationMs,
          });
          const row = await this.repo.insertRun(tx, {
            ...base,
            status: "ok",
            failureCode: null,
            results,
            workType,
            priceBrl: record.priceBrl.toFixed(2),
            auditId: review.auditId,
          });
          if (row === null) throw new AlreadyRanError();
        });
      } catch (err) {
        if (!(err instanceof AlreadyRanError)) throw err;
        return { status: "already_ran", failureCode: null };
      }
      settled = true;
      return { status: "ok", failureCode: null };
    } finally {
      if (!settled) await this.refund(quotaTenant, aop.id, clientId);
    }
  }

  /** `failed`/`skipped`: sem cobrança (work_type e price_brl nulos, como exige o banco). */
  private insertUnbilled(
    run: Pick<NewAopRun, "aopId" | "clientId" | "fireAt" | "trigger"> & {
      status: "failed" | "skipped";
    },
    failureCode: NonNullable<AopRun["failureCode"]>,
    results: Record<string, unknown>,
  ) {
    return this.db.tx((tx: Tx) =>
      this.repo.insertRun(tx, {
        ...run,
        failureCode,
        results,
        workType: null,
        priceBrl: null,
        auditId: null,
      }),
    );
  }

  private async refund(tenant: QuotaTenant, aopId: string, clientId: string): Promise<void> {
    try {
      await this.quota.refund(tenant);
    } catch (err) {
      this.logger.error({
        msg: "Falha ao devolver a cota do AOP",
        ...errorFields(err),
        tenantId: tenant.tenantId,
        aopId,
        clientId,
      });
    }
  }
}
