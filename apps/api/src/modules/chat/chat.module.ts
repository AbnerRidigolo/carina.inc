import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { BillingModule } from "../billing/billing.module.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { OrchestratorModule } from "../orchestrator/orchestrator.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { WatchtowerModule } from "../watchtower/watchtower.module.js";
import { ChatController } from "./chat.controller.js";
import { CHAT_GATEWAY_OPTIONS, ChatGateway } from "./chat.gateway.js";
import { ChatService } from "./chat.service.js";
import { InboxBroadcast } from "./inbox-broadcast.js";
import { WsTicketService } from "./ws-ticket.service.js";

/**
 * Chat: `POST /api/chat`, `POST /api/ws/ticket` e o gateway `/ws/chat` (exige o adaptador `ws`:
 * `configureWebSockets(app)` no bootstrap). Importa o TenancyModule antes do LimitsModule para a
 * ordem dos guards globais (ApiKeyGuard → RateLimitGuard). LockService e StreamsService vêm do
 * RedisModule global. O InboxBroadcast abre um tail de `inbox.events` por processo.
 */
@Module({
  imports: [
    DatabaseModule,
    TenancyModule,
    LimitsModule,
    BillingModule,
    WatchtowerModule,
    InboxModule,
    OrchestratorModule,
  ],
  controllers: [ChatController],
  providers: [
    // Padrões do heartbeat e da ociosidade (substituível nos testes).
    { provide: CHAT_GATEWAY_OPTIONS, useValue: {} },
    ChatService,
    WsTicketService,
    InboxBroadcast,
    ChatGateway,
  ],
  exports: [ChatService, WsTicketService, InboxBroadcast],
})
export class ChatModule {}
