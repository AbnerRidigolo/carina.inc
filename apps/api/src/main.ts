/**
 * Processo HTTP da API (REST + WebSocket na mesma porta). Com WORKERS_ENABLED !== "false" também
 * roda os workers de fundo (útil em desenvolvimento, um processo só); no docker compose a API sobe
 * com WORKERS_ENABLED=false e os workers rodam no serviço `worker` (main.worker.ts).
 */
import { Logger } from "@nestjs/common";
import { createApiApp } from "./bootstrap.js";
import { ENV } from "./core/config/config.module.js";
import type { Env } from "./core/config/env.js";

try {
  const app = await createApiApp();
  const env = app.get<Env>(ENV);
  await app.listen(env.PORT, "0.0.0.0");
  new Logger("Bootstrap").log({
    msg: "API no ar",
    port: env.PORT,
    workers: env.WORKERS_ENABLED === "true",
    llmMode: env.LLM_MODE,
  });
} catch (err) {
  // Antes do pino existir (ex.: Env inválido) só resta o stderr; a mensagem do loadEnv lista os
  // nomes das variáveis inválidas, nunca os valores.
  console.error("Falha ao iniciar a API:", err instanceof Error ? err.message : err);
  process.exit(1);
}
