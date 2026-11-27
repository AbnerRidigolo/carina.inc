import {
  AOP_MAX_PER_TENANT,
  AopCreateSchema,
  AopUpdateSchema,
  type Aop,
  type AopCreate,
  type AopCreated,
  type AopRunPage,
  type AopUpdate,
} from "@carina/shared";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import {
  AopDisabledError,
  ManualRunTooSoonError,
  NotFoundError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { REDIS } from "../../core/redis/redis.tokens.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { CurrentTenant } from "../tenancy/current-tenant.decorator.js";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { AopCompiler } from "./compiler.js";
import { AopsRepository } from "./aops.repository.js";

export const DEFAULT_RUNS_LIMIT = 20;
export const MAX_RUNS_LIMIT = 50;
/** Um disparo manual por AOP por minuto. */
export const MANUAL_RUN_WINDOW_MS = 60_000;
export const manualRunKey = (aopId: string): string => `aop:manual:${aopId}`;

/** `?limit=` (1 a 50, padrão 20) e `?cursor=` (o `nextCursor` da página anterior). */
const RunsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d{1,3}$/, "precisa ser um inteiro")
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_RUNS_LIMIT))
    .default(DEFAULT_RUNS_LIMIT),
  cursor: z.string().min(1).max(256).optional(),
});
type RunsQuery = z.output<typeof RunsQuerySchema>;

/**
 * Procedimentos operacionais agendados (escopo `aops:manage`, spec §4.5). Criar compila a descrição
 * (LLM com contingência heurística) e NÃO cobra: o freio do custo da compilação é o limite global
 * de requisições. No limite de 50 AOPs, uma contagem sob RLS recusa (422) ANTES do LLM; o limite que
 * vale é o de `create`, sob lock. `clientIds` (1 a 20, sem repetição) são externalIds; um id
 * desconhecido é aceito na criação (vira `client_not_found` na execução, como no Python) e volta em
 * `unknownClientIds` no 201. O AOP nasce com `last_fire_at` no último horário agendado (o primeiro
 * disparo é o próximo horário) e religar não dispara os horários perdidos. AOP de outro tenant é
 * indistinguível de inexistente (404, RLS).
 *
 * `POST :id/run` só enfileira: 202 com o `fireAt` (o instante do pedido, +1 ms se cair no .000 de um
 * minuto cheio) e o worker executa. Não mexe em `last_fire_at` (não consome o disparo agendado).
 * Desligado → 409 `aop_disabled`. Limite de 1 por AOP por minuto, atômico no Redis (`SET NX PX`,
 * chave `aop:manual:<aopId>`), só depois de o AOP existir e estar ligado (404/409 não gastam o
 * minuto); se a publicação falha, o guard é desfeito. Repetido → 409 `manual_run_too_soon` com
 * `Retry-After`.
 *
 * Logs: só ids, agentes e contagens (nunca a descrição nem o nome).
 */
@Controller("aops")
export class AopsController {
  private readonly logger = new Logger(AopsController.name);

  constructor(
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(AopsRepository) private readonly aops: AopsRepository,
    @Inject(AopCompiler) private readonly compiler: AopCompiler,
    @Inject(StreamsService) private readonly streams: Pick<StreamsService, "publish">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "del" | "pttl">,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post()
  @RequireScopes("aops:manage")
  async create(
    @CurrentTenant() tenant: AuthTenant,
    @Body(new ZodValidationPipe(AopCreateSchema)) body: AopCreate,
  ): Promise<AopCreated> {
    // Pré-checagem barata ANTES do LLM: no limite, nem compila (a compilação é a parte cara). O
    // limite que vale continua sendo o conferido sob lock dentro de `create`.
    const count = await this.db.tx((tx) => this.aops.count(tx));
    if (count >= AOP_MAX_PER_TENANT) {
      throw new ValidationError(`Limite de ${String(AOP_MAX_PER_TENANT)} AOPs por tenant atingido`);
    }
    const compiled = await this.compiler.compile(body.description);
    const now = this.clock();
    const { created, unknownClientIds } = await this.db.tx(async (tx) => ({
      created: await this.aops.create(
        tx,
        {
          name: body.name ?? compiled.name,
          description: body.description,
          agents: compiled.agents,
          schedule: compiled.schedule,
          clientIds: body.clientIds,
        },
        now,
      ),
      unknownClientIds: await this.aops.unknownClientIds(tx, body.clientIds),
    }));
    this.logger.log({
      msg: "Procedimento criado",
      tenantId: tenant.tenantId,
      aopId: created.id,
      agents: created.agents,
      clients: created.clientIds.length,
      unknownClients: unknownClientIds.length,
      via: compiled.via,
    });
    return { ...created, unknownClientIds };
  }

  @Get()
  @RequireScopes("aops:manage")
  list(): Promise<Aop[]> {
    return this.db.tx((tx) => this.aops.list(tx));
  }

  @Get(":id")
  @RequireScopes("aops:manage")
  get(@Param("id") id: string): Promise<Aop> {
    return this.load(id);
  }

  @Patch(":id")
  @RequireScopes("aops:manage")
  async update(
    @CurrentTenant() tenant: AuthTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(AopUpdateSchema)) body: AopUpdate,
  ): Promise<Aop> {
    const updated = await this.db.tx((tx) =>
      this.aops.setEnabled(tx, id, body.enabled, this.clock()),
    );
    if (updated === null) throw new NotFoundError("Procedimento não encontrado");
    this.logger.log({
      msg: "Procedimento atualizado",
      tenantId: tenant.tenantId,
      aopId: updated.id,
      enabled: updated.enabled,
    });
    return updated;
  }

  @Post(":id/run")
  @HttpCode(202)
  @RequireScopes("aops:manage")
  async run(
    @CurrentTenant() tenant: AuthTenant,
    @Param("id") id: string,
  ): Promise<{ fireAt: string }> {
    const aop = await this.load(id);
    if (!aop.enabled) throw new AopDisabledError("Procedimento desligado");
    const key = manualRunKey(aop.id);
    const won = await this.redis.set(key, "1", "PX", MANUAL_RUN_WINDOW_MS, "NX");
    if (won !== "OK") {
      const ttl = await this.redis.pttl(key);
      const retryAfter = Math.max(1, Math.ceil((ttl > 0 ? ttl : MANUAL_RUN_WINDOW_MS) / 1000));
      throw new ManualRunTooSoonError(
        "Já há um disparo manual deste procedimento no último minuto",
        retryAfter,
      );
    }
    // Um instante no .000 de um minuto cheio poderia ser igual a um horário agendado (sempre em hora
    // cheia) e colidir no único de aop_run; +1 ms garante que nunca é.
    const now = this.clock();
    const fireAt = new Date(now % 60_000 === 0 ? now + 1 : now).toISOString();
    try {
      await this.streams.publish("jobs", {
        eventId: randomUUID(),
        type: "aop.run_requested",
        tenantId: tenant.tenantId,
        clientId: "",
        aopId: aop.id,
        fireAt,
      });
    } catch (err) {
      // Nada foi enfileirado: devolve o minuto para o cliente tentar de novo.
      await this.redis.del(key).catch(() => undefined);
      throw err;
    }
    this.logger.log({
      msg: "Disparo manual solicitado",
      tenantId: tenant.tenantId,
      aopId: aop.id,
      fireAt,
    });
    return { fireAt };
  }

  @Get(":id/runs")
  @RequireScopes("aops:manage")
  async runs(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(RunsQuerySchema)) query: RunsQuery,
  ): Promise<AopRunPage> {
    const aop = await this.load(id);
    return this.db.tx((tx) => this.aops.listRuns(tx, aop.id, query.cursor ?? null, query.limit));
  }

  private async load(id: string): Promise<Aop> {
    const found = await this.db.tx((tx) => this.aops.get(tx, id));
    if (found === null) throw new NotFoundError("Procedimento não encontrado");
    return found;
  }
}
