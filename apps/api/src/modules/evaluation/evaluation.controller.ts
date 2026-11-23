import {
  EvalCategorySchema,
  EvalSubmitSchema,
  EvalUsageSchema,
  type EvalCaseView,
  type EvalReport,
  type EvalSubmit,
  type EvalUsage,
} from "@carina/shared";
import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Query } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { BillingService } from "../billing/billing.service.js";
import { PRICE_BRL } from "../billing/pricing.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { QuotaService } from "../limits/quota.service.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { CurrentTenant } from "../tenancy/current-tenant.decorator.js";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { catalog, evaluate } from "./grading.js";

/** O preço devolvido vem da mesma tabela que o billing cobra. */
const USAGE = EvalUsageSchema.parse({
  workType: "evaluation",
  priceBrl: PRICE_BRL.evaluation,
}) satisfies EvalUsage;

const CasesQuerySchema = z.object({ category: EvalCategorySchema.optional() });
type CasesQuery = z.output<typeof CasesQuerySchema>;

/**
 * Benchmark SEAL BR (escopo `eval:run`). O catálogo é grátis e nunca traz o gabarito. A submissão:
 *  1. valida o corpo e corrige (`evaluate`): 422 aqui não reserva cota nem cobra;
 *  2. reserva 1 unidade da cota mensal (`QuotaService.reserve`), como o chat: esgotada → 429 com
 *     `Retry-After`, sem cobrança;
 *  3. cobra `evaluation` UMA vez, com `clientId` nulo (o benchmark é do tenant); se a cobrança
 *     falha, devolve a cota (`refund`) e repassa o erro.
 * Respostas e gabarito nunca vão para log: o corpo só é lido pelo motor de correção, os erros
 * listam ids (nunca texto) e o relatório só traz contagens.
 */
@Controller("eval")
export class EvaluationController {
  private readonly logger = new Logger(EvaluationController.name);

  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  @Get("cases")
  @RequireScopes("eval:run")
  cases(@Query(new ZodValidationPipe(CasesQuerySchema)) query: CasesQuery): EvalCaseView[] {
    return catalog(query.category);
  }

  @Post("submit")
  @HttpCode(200)
  @RequireScopes("eval:run")
  async submit(
    @CurrentTenant() tenant: AuthTenant,
    @Body(new ZodValidationPipe(EvalSubmitSchema)) body: EvalSubmit,
  ): Promise<EvalReport> {
    const started = this.clock();
    const report = evaluate(body.answers);
    await this.quota.reserve(tenant);
    try {
      await this.billing.record({
        workType: "evaluation",
        agents: [],
        durationMs: Math.max(0, Math.round(this.clock() - started)),
      });
    } catch (err) {
      await this.quota.refund(tenant).catch((refundErr: unknown) => {
        // Só ids: nem o corpo nem o relatório vão para o log.
        this.logger.error({
          msg: "Falha ao devolver a cota da avaliação com erro na cobrança",
          err: refundErr,
          tenantId: tenant.tenantId,
          keyId: tenant.keyId,
        });
      });
      throw err;
    }
    return { ...report, usage: USAGE };
  }
}
