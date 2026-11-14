import type { INestApplication } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";

/**
 * Adaptador de WebSocket (`ws`, sem socket.io): os gateways compartilham o servidor HTTP (mesma
 * porta) e cada um atende só o seu caminho (ex.: `/ws/chat`). Aplique no bootstrap (main.ts) e no
 * app de teste, antes de `listen`/`init`.
 */
export function configureWebSockets(app: INestApplication): void {
  app.useWebSocketAdapter(new WsAdapter(app));
}
