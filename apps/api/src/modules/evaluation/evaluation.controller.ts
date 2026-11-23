import {
  EvalCategorySchema,
  EvalSubmitSchema,
  EvalUsageSchema,
  type EvalCaseView,
  type EvalReport,
  type EvalSubmit,
  type EvalUsage,
} from "@carina/shared";
import { Body, Controller, Get, HttpCode, Inject, Post, Query } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { BillingService } from "../billing/billing.service.js";
import { PRICE_BRL } from "../billing/pricing.js";
import { CLOCK, type Clock } from "../limits/clock.js";
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
 * Benchmark SEAL BR (escopo `eval:run`). O catálogo é grátis e nunca traz o gabarito. A submissão é
 * cobrada como `evaluation` UMA vez, DEPOIS de corrigir com sucesso (422 e falhas não cobram), com
 * `clientId` nulo (o benchmark é do tenant). Respostas e gabarito nunca vão para log: o corpo só é
 * lido pelo motor de correção, e os erros listam ids, nunca texto.
 */
@Controller("eval")
export class EvaluationController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(CLOCK) private readonly clock: Clock,
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
    @Body(new ZodValidationPipe(EvalSubmitSchema)) body: EvalSubmit,
  ): Promise<EvalReport> {
    const started = this.clock();
    const report = evaluate(body.answers);
    await this.billing.record({
      workType: "evaluation",
      agents: [],
      durationMs: Math.max(0, Math.round(this.clock() - started)),
    });
    return { ...report, usage: USAGE };
  }
}
