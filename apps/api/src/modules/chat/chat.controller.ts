import { type ChatResponse, type WsTicket, WsTicketRequestSchema } from "@carina/shared";
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { ValidationError } from "../../core/errors/domain-errors.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { ClientsService } from "../tenancy/clients.service.js";
import { CurrentTenant } from "../tenancy/current-tenant.decorator.js";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { ChatService } from "./chat.service.js";
import { WsTicketService } from "./ws-ticket.service.js";

interface HttpReq {
  id?: unknown;
}
interface HttpRes {
  readonly writableFinished: boolean;
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

@Controller()
export class ChatController {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(WsTicketService) private readonly tickets: WsTicketService,
    @Inject(ClientsService) private readonly clients: ClientsService,
  ) {}

  /**
   * Um turno sem streaming: `{ threadId, status, plan, results, answer, approval?, usage,
   * compliance }`. Erros em RFC 9457 (422 validação, 404 thread de outro cliente, 409 thread
   * ocupado ou aguardando aprovação, 429 limite/cota, 503 todos os provedores fora). Se o cliente
   * desconectar antes do fim, o turno termina em segundo plano (ver ChatService).
   */
  @Post("chat")
  @HttpCode(200)
  @RequireScopes("chat")
  async send(
    @CurrentTenant() tenant: AuthTenant,
    @Body() body: unknown,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ): Promise<ChatResponse | undefined> {
    const disconnected = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) disconnected.abort();
    };
    res.on("close", onClose);
    try {
      return await this.chat.chat(tenant, body, "rest", {
        signal: disconnected.signal,
        ...(req.id !== undefined && req.id !== null ? { traceId: String(req.id) } : {}),
      });
    } finally {
      res.off("close", onClose);
    }
  }

  /**
   * Ticket de uso único (30 s) para abrir `/ws/chat?ticket=…`, preso ao tenant e à chave da
   * requisição e ao cliente final do corpo (criado se ainda não existir, como no chat).
   */
  @Post("ws/ticket")
  @RequireScopes("chat")
  async ticket(@CurrentTenant() tenant: AuthTenant, @Body() body: unknown): Promise<WsTicket> {
    const parsed = WsTicketRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; "),
      );
    }
    const client = await this.clients.resolve(parsed.data.clientId, { create: true });
    return this.tickets.issue(tenant, client);
  }
}
