/**
 * Bootstrap compartilhado: main.ts e main.worker.ts chamam estas funções, e os testes de boot
 * (test/health/health.e2e.spec.ts) também — os testes exercitam a fiação real, não uma cópia.
 */
import type { INestApplication, INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import { AppModule, type AppModuleOptions } from "./app.module.js";
import { ENV } from "./core/config/config.module.js";
import type { Env } from "./core/config/env.js";
import { ProblemDetailsFilter } from "./core/errors/problem-details.filter.js";
import { configureBodyParser } from "./core/http/body-parser.js";
import { configureWebSockets } from "./core/http/websocket.js";
import { WorkerModule } from "./worker.module.js";

/** Prefixo global das rotas REST (os gateways WebSocket têm caminho próprio, ex.: `/ws/chat`). */
export const API_PREFIX = "api";

/**
 * Pipeline HTTP da API: corpo JSON até 5 MB, adaptador `ws` (WebSocket na mesma porta), prefixo
 * `/api`, CORS restrito ao WEB_ORIGIN e ProblemDetailsFilter global. Aplique antes de
 * `listen`/`init`. Usado pelo createApiApp e pelo app dos testes E2E.
 *
 * CORS: a lista com uma só origem faz o `cors` devolver Access-Control-Allow-Origin apenas quando
 * a origem bate (nunca `*`, nunca a origem refletida de outro site). Sem credenciais: o frontend
 * manda a chave em header, não há cookie. Retry-After e X-Request-Id ficam legíveis no browser.
 */
export function configureHttpApp(app: INestApplication, env: Pick<Env, "WEB_ORIGIN">): void {
  configureBodyParser(app as NestExpressApplication);
  configureWebSockets(app);
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: [env.WEB_ORIGIN],
    credentials: false,
    exposedHeaders: ["Retry-After", "X-Request-Id"],
    maxAge: 600,
  });
  app.useGlobalFilters(new ProblemDetailsFilter());
}

/**
 * App HTTP de produção (sem `listen`): AppModule, logs pelo pino desde o primeiro registro
 * (`bufferLogs` segura os logs do boot até `useLogger`), pipeline HTTP e shutdown hooks (SIGTERM
 * fecha workers, sockets e conexões). `abortOnError: false`: erro de boot é lançado ao chamador
 * em vez de matar o processo por dentro do Nest.
 */
export async function createApiApp(opts: AppModuleOptions = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(opts), {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  configureHttpApp(app, app.get<Env>(ENV));
  app.enableShutdownHooks();
  return app;
}

/**
 * Contexto do processo de workers: WorkerModule sem servidor HTTP. Força WORKERS_ENABLED=true
 * ANTES de criar o contexto (o Env é lido na instanciação do ConfigModule), então os workers ligam
 * no `onApplicationBootstrap` mesmo que o ambiente diga outra coisa.
 */
export async function createWorkerContext(): Promise<INestApplicationContext> {
  process.env["WORKERS_ENABLED"] = "true";
  const ctx = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  ctx.useLogger(ctx.get(Logger));
  ctx.enableShutdownHooks();
  return ctx;
}
