import { DecisionRequestSchema, type ApprovalView, type DecisionRequest } from "@carina/shared";
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import { CurrentTenant } from "../tenancy/current-tenant.decorator.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { RequireAnyScope, RequireScopes } from "../tenancy/scopes.decorator.js";
import { InboxService } from "./inbox.service.js";

/**
 * Inbox de aprovações. A solicitação de outro tenant é indistinguível de uma inexistente (404
 * idêntico); vencida ou já decidida → 409.
 */
@Controller()
export class InboxController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService) {}

  /** Pendentes do cliente (`:clientId` é o externalId): escopo `chat` OU `inbox:decide`. */
  @Get("clients/:clientId/inbox")
  @RequireAnyScope("chat", "inbox:decide")
  pending(@Param("clientId") clientId: string): Promise<ApprovalView[]> {
    return this.inbox.listPending(clientId);
  }

  @Post("inbox/:id/decision")
  @HttpCode(200)
  @RequireScopes("inbox:decide")
  decide(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DecisionRequestSchema)) body: DecisionRequest,
    @CurrentTenant() by: AuthTenant,
  ): Promise<ApprovalView> {
    return this.inbox.decide(id, body, by);
  }
}
