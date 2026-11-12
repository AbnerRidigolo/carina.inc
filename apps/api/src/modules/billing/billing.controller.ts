import type { UsageSummary } from "@carina/shared";
import { Controller, Get, Inject, Query } from "@nestjs/common";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { BillingService } from "./billing.service.js";

@Controller("usage")
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  /** Resumo de uso do mês (`?month=YYYY-MM`, default o mês corrente) do tenant da chave. */
  @Get()
  @RequireScopes("chat")
  summary(@Query("month") month?: string): Promise<UsageSummary> {
    return this.billing.summary(month);
  }
}
