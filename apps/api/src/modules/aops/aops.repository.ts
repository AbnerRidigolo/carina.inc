/**
 * SQL dos AOPs (spec §4.3–4.4, tabelas `aop` e `aop_run` da migração 0011). Tudo sob RLS por
 * tenant: cada método (menos `tenantIds`) recebe a `tx` aberta por `TenantPrismaService.tx` com o
 * tenant fixado (o repositório não guarda estado nem abre transação).
 *
 * - `create`: serializa as criações do tenant com `pg_advisory_xact_lock` e conta na mesma
 *   transação (limite de `AOP_MAX_PER_TENANT`, ligados ou não), como o builder;
 * - `get`, `setEnabled`, `claimFire`, `listRuns`: id malformado → `null`/`false`/página vazia sem
 *   consultar (nunca 500 por cast de uuid);
 * - `claimFire`: o disparo idempotente do spec §4.4 (UPDATE condicional em `last_fire_at`); o
 *   disparo manual passa por ele também, com `fireAt` = agora;
 * - `insertRun`: `ON CONFLICT (aop_id, client_id, fire_at) DO NOTHING`; devolve `null` se já havia;
 * - `tenantIds`: único ponto sem tenant fixado, via `aop_tenant_ids()` (SECURITY DEFINER), que
 *   devolve só ids.
 *
 * `client_ids` do AOP são externalIds; `aop_run.client_id` é o uuid interno, e a execução sai com o
 * externalId do cliente (join sob a mesma RLS). Preço sai do banco como texto, nunca por `number`.
 */
import {
  AOP_MAX_PER_TENANT,
  type Aop,
  type AopRun,
  type AopRunPage,
  type Money,
  type WorkType,
} from "@carina/shared";
import { Inject, Injectable } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../monitor/monitor.repository.js";

type Tx = Prisma.TransactionClient;

/** AOP a gravar: o que a compilação produz (o resto vem do banco). */
export type NewAop = Pick<Aop, "name" | "description" | "agents" | "schedule" | "clientIds">;

/** Execução a gravar. `clientId` é o uuid INTERNO do cliente (já resolvido sob o tenant). */
export interface NewAopRun {
  aopId: string;
  clientId: string;
  fireAt: Date;
  trigger: AopRun["trigger"];
  status: AopRun["status"];
  failureCode: AopRun["failureCode"];
  results: Record<string, unknown>;
  /** só em `ok` (o banco recusa cobrança em pulado/falho) */
  workType: WorkType | null;
  priceBrl: Money | null;
  auditId: string | null;
}

interface AopRow {
  id: string;
  name: string;
  description: string;
  agents: Aop["agents"];
  frequency: Aop["schedule"]["frequency"];
  weekday: number;
  day: number;
  hour: number;
  client_ids: string[];
  enabled: boolean;
  last_fire_at: Date | null;
  created_at: Date;
}

interface RunRow {
  id: string;
  aop_id: string;
  external_id: string;
  fire_at: Date;
  trigger: AopRun["trigger"];
  status: AopRun["status"];
  failure_code: AopRun["failureCode"];
  results: Record<string, unknown>;
  work_type: WorkType | null;
  price_brl: string | null;
  created_at: Date;
  /** `created_at` em UTC com microssegundos, para o cursor (Date só guarda milissegundos) */
  created_at_us: string;
}

const AOP_COLUMNS = Prisma.sql`
  id::text, name, description, agents, frequency, weekday, day, hour, client_ids, enabled,
  last_fire_at, created_at`;

/** Colunas da execução; `r` é aop_run e `c` o cliente dela. */
const RUN_COLUMNS = Prisma.sql`
  r.id::text, r.aop_id::text, c.external_id, r.fire_at, r.trigger, r.status, r.failure_code,
  r.results, r.work_type, r.price_brl::text AS price_brl, r.created_at,
  to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toAop(row: AopRow): Aop {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    agents: row.agents,
    schedule: { frequency: row.frequency, weekday: row.weekday, day: row.day, hour: row.hour },
    clientIds: row.client_ids,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    lastFireAt: row.last_fire_at === null ? null : row.last_fire_at.toISOString(),
  };
}

function toRun(row: RunRow): AopRun {
  return {
    id: row.id,
    aopId: row.aop_id,
    clientId: row.external_id,
    fireAt: row.fire_at.toISOString(),
    trigger: row.trigger,
    status: row.status,
    failureCode: row.failure_code,
    results: row.results,
    workType: row.work_type,
    priceBrl: row.price_brl,
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class AopsRepository {
  constructor(@Inject(TenantPrismaService) private readonly db: TenantPrismaService) {}

  /** Tenants não suspensos com ao menos um AOP habilitado (só ids). */
  tenantIds(): Promise<string[]> {
    return this.db.aopTenantIds();
  }

  /**
   * Grava o AOP (habilitado) no tenant fixado. A entrada já vem validada e normalizada pela
   * compilação (os CHECKs do banco são a última barreira).
   *
   * @throws ValidationError (422) se o tenant já tem `AOP_MAX_PER_TENANT` AOPs.
   */
  async create(tx: Tx, input: NewAop): Promise<Aop> {
    const { tenantId } = TenantContext.current();
    // Serializa as criações do mesmo tenant até o fim da transação; em READ COMMITTED (o padrão de
    // `TenantPrismaService.tx`) a contagem abaixo enxerga o que a criação anterior confirmou. Ver
    // StrategyRepository.create: não abra esta `tx` com outro isolamento.
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
        'aop_create', ${tenantId}::text
      )::text, 0)) IS NULL AS locked`;
    const counted = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM aop WHERE tenant_id = ${tenantId}::uuid`;
    if ((counted[0]?.n ?? 0) >= AOP_MAX_PER_TENANT) {
      throw new ValidationError(`Limite de ${String(AOP_MAX_PER_TENANT)} AOPs por tenant atingido`);
    }
    const { frequency, weekday, day, hour } = input.schedule;
    const rows = await tx.$queryRaw<AopRow[]>`
      INSERT INTO aop (tenant_id, name, description, agents, frequency, weekday, day, hour,
                       client_ids)
      VALUES (${tenantId}::uuid, ${input.name}, ${input.description}, ${input.agents}::text[],
              ${frequency}, ${weekday}, ${day}, ${hour}, ${input.clientIds}::text[])
      RETURNING ${AOP_COLUMNS}`;
    const inserted = rows[0];
    if (inserted === undefined) throw new Error("INSERT em aop não devolveu a linha");
    return toAop(inserted);
  }

  /** AOPs do tenant fixado, mais novos primeiro. */
  async list(tx: Tx): Promise<Aop[]> {
    const rows = await tx.$queryRaw<AopRow[]>`
      SELECT ${AOP_COLUMNS} FROM aop ORDER BY created_at DESC, id DESC`;
    return rows.map(toAop);
  }

  /** AOP do tenant fixado; `null` se o id é malformado, não existe ou é de outro tenant. */
  async get(tx: Tx, id: string): Promise<Aop | null> {
    if (!UUID_RE.test(id)) return null;
    const rows = await tx.$queryRaw<AopRow[]>`
      SELECT ${AOP_COLUMNS} FROM aop WHERE id = ${id}::uuid`;
    const row = rows[0];
    return row === undefined ? null : toAop(row);
  }

  /** Liga/desliga o AOP; devolve o AOP atualizado, ou `null` como em `get`. */
  async setEnabled(tx: Tx, id: string, enabled: boolean): Promise<Aop | null> {
    if (!UUID_RE.test(id)) return null;
    const rows = await tx.$queryRaw<AopRow[]>`
      UPDATE aop SET enabled = ${enabled} WHERE id = ${id}::uuid RETURNING ${AOP_COLUMNS}`;
    const row = rows[0];
    return row === undefined ? null : toAop(row);
  }

  /**
   * Disparo idempotente (spec §4.4): grava `fireAt` como último disparo só se o AOP está habilitado
   * e ainda não disparou nesse horário nem depois dele. `true` só para quem ganhou: em disparos
   * concorrentes do mesmo horário, o segundo espera o lock da linha e, em READ COMMITTED, reavalia a
   * condição com o `last_fire_at` já gravado (e perde).
   */
  async claimFire(tx: Tx, id: string, fireAt: Date): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    const fire = fireAt.toISOString();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE aop SET last_fire_at = ${fire}::timestamptz
       WHERE id = ${id}::uuid AND enabled
         AND (last_fire_at IS NULL OR last_fire_at < ${fire}::timestamptz)
      RETURNING id::text`;
    return rows.length > 0;
  }

  /** AOPs habilitados do tenant fixado (o job filtra os vencidos com `isDue`), mais antigos antes. */
  async dueAops(tx: Tx): Promise<Aop[]> {
    const rows = await tx.$queryRaw<AopRow[]>`
      SELECT ${AOP_COLUMNS} FROM aop WHERE enabled ORDER BY created_at, id`;
    return rows.map(toAop);
  }

  /**
   * Grava a execução se ainda não há uma do mesmo AOP, cliente e horário (`ON CONFLICT DO
   * NOTHING`). Devolve a execução gravada (com o externalId do cliente), ou `null` se já existia.
   */
  async insertRun(tx: Tx, run: NewAopRun): Promise<AopRun | null> {
    const { tenantId } = TenantContext.current();
    const rows = await tx.$queryRaw<RunRow[]>`
      WITH r AS (
        INSERT INTO aop_run (tenant_id, aop_id, client_id, fire_at, trigger, status, failure_code,
                             results, work_type, price_brl, audit_id)
        VALUES (${tenantId}::uuid, ${run.aopId}::uuid, ${run.clientId}::uuid,
                ${run.fireAt.toISOString()}::timestamptz, ${run.trigger}, ${run.status},
                ${run.failureCode}, ${JSON.stringify(run.results)}::jsonb, ${run.workType},
                ${run.priceBrl}::numeric, ${run.auditId}::uuid)
        ON CONFLICT (aop_id, client_id, fire_at) DO NOTHING
        RETURNING *
      )
      SELECT ${RUN_COLUMNS}
        FROM r JOIN client c ON c.tenant_id = r.tenant_id AND c.id = r.client_id`;
    const inserted = rows[0];
    return inserted === undefined ? null : toRun(inserted);
  }

  /**
   * Execuções do AOP, mais novas primeiro, keyset por `(created_at, id)`. `cursor` é o `nextCursor`
   * da página anterior (inválido → ValidationError); pede `limit + 1` para saber se há próxima.
   * AOP malformado, inexistente ou de outro tenant → página vazia.
   */
  async listRuns(tx: Tx, aopId: string, cursor: string | null, limit: number): Promise<AopRunPage> {
    const after = cursor === null ? null : decodeCursor(cursor);
    if (!UUID_RE.test(aopId)) return { items: [], nextCursor: null };
    const keyset =
      after === null
        ? Prisma.empty
        : Prisma.sql`AND (r.created_at, r.id) < (${after.createdAtUs}::timestamptz, ${after.id}::uuid)`;
    const rows = await tx.$queryRaw<RunRow[]>`
      SELECT ${RUN_COLUMNS}
        FROM aop_run r JOIN client c ON c.tenant_id = r.tenant_id AND c.id = r.client_id
       WHERE r.aop_id = ${aopId}::uuid ${keyset}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toRun),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(last.created_at_us, last.id)
          : null,
    };
  }
}
