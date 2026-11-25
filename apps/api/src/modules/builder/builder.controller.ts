import {
  BacktestUsageSchema,
  HistoryRangeSchema,
  StrategyCreateSchema,
  type BacktestResult,
  type BacktestUsage,
  type Strategy,
  type StrategyCreate,
} from "@carina/shared";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { NotFoundError } from "../../core/errors/domain-errors.js";
import { BillingService } from "../billing/billing.service.js";
import { PRICE_BRL } from "../billing/pricing.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { QuotaService } from "../limits/quota.service.js";
import { MarketService } from "../market/market.service.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { CurrentTenant } from "../tenancy/current-tenant.decorator.js";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { runBacktest } from "./backtest.js";
import { StrategyRepository } from "./strategy.repository.js";

/** O preço devolvido vem da mesma tabela que o billing cobra. */
const USAGE = BacktestUsageSchema.parse({
  workType: "backtest",
  priceBrl: PRICE_BRL.backtest,
}) satisfies BacktestUsage;

const BacktestQuerySchema = z.object({ range: HistoryRangeSchema.default("1y") });
type BacktestQuery = z.output<typeof BacktestQuerySchema>;

/**
 * Estratégias declarativas e backtest (escopo `builder:run`). Criar, listar e ler são grátis. O
 * backtest, nesta ordem:
 *  1. a estratégia existe e é do tenant (RLS): senão 404;
 *  2. o histórico vem do MarketService (cache e orçamento das rotas): orçamento esgotado → 503 com
 *     `Retry-After`, provedor fora → 502;
 *  3. o motor roda: histórico insuficiente ou fechamento não positivo → 422;
 *  4. SÓ ENTÃO reserva 1 unidade da cota mensal (esgotada → 429 com `Retry-After`) e cobra
 *     `backtest` UMA vez, com `clientId` nulo; se a cobrança falha, devolve a cota (`refund`) e
 *     repassa o erro.
 * Nenhum erro dos passos 1–3 reserva cota nem cobra. Logs: só ids, `kind` e contagens (nunca o
 * nome da estratégia).
 */
@Controller("builder/strategies")
export class BuilderController {
  private readonly logger = new Logger(BuilderController.name);

  constructor(
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(StrategyRepository) private readonly strategies: StrategyRepository,
    @Inject(MarketService) private readonly market: MarketService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  @Post()
  @RequireScopes("builder:run")
  async create(
    @CurrentTenant() tenant: AuthTenant,
    @Body(new ZodValidationPipe(StrategyCreateSchema)) body: StrategyCreate,
  ): Promise<Strategy> {
    const created = await this.db.tx((tx) => this.strategies.create(tx, body));
    this.logger.log({
      msg: "Estratégia criada",
      tenantId: tenant.tenantId,
      strategyId: created.id,
      kind: created.spec.kind,
    });
    return created;
  }

  @Get()
  @RequireScopes("builder:run")
  list(): Promise<Strategy[]> {
    return this.db.tx((tx) => this.strategies.list(tx));
  }

  @Get(":id")
  @RequireScopes("builder:run")
  async get(@Param("id") id: string): Promise<Strategy> {
    return this.load(id);
  }

  @Post(":id/backtest")
  @HttpCode(200)
  @RequireScopes("builder:run")
  async backtest(
    @CurrentTenant() tenant: AuthTenant,
    @Param("id") id: string,
    @Query(new ZodValidationPipe(BacktestQuerySchema)) query: BacktestQuery,
  ): Promise<BacktestResult> {
    const started = this.clock();
    const strategy = await this.load(id);
    const { kind, symbol, fast, slow } = strategy.spec;
    const bars = await this.market.history(symbol, query.range);
    const result = runBacktest({ kind, symbol, bars, fast, slow });
    await this.quota.reserve(tenant);
    try {
      await this.billing.record({
        workType: "backtest",
        agents: [],
        durationMs: Math.max(0, Math.round(this.clock() - started)),
      });
    } catch (err) {
      await this.quota.refund(tenant).catch((refundErr: unknown) => {
        this.logger.error({
          msg: "Falha ao devolver a cota do backtest com erro na cobrança",
          err: refundErr,
          tenantId: tenant.tenantId,
          keyId: tenant.keyId,
        });
      });
      throw err;
    }
    this.logger.log({
      msg: "Backtest executado",
      tenantId: tenant.tenantId,
      strategyId: strategy.id,
      kind,
      bars: result.bars,
    });
    return { ...result, usage: USAGE };
  }

  private async load(id: string): Promise<Strategy> {
    const found = await this.db.tx((tx) => this.strategies.get(tx, id));
    if (found === null) throw new NotFoundError("Estratégia não encontrada");
    return found;
  }
}
