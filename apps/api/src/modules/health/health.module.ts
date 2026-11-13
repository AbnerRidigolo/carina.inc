import { Module } from "@nestjs/common";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { pingPostgres } from "../../core/database/database-health.js";
import { pingRedis } from "../../core/redis/redis-health.js";
import {
  DEFAULT_READY_TIMEOUT_MS,
  HealthController,
  READINESS_PROBES,
  type ReadinessProbes,
} from "./health.controller.js";

/**
 * `/api/health` e `/api/ready`. As sondas usam conexões próprias e descartáveis (ver
 * database-health.ts e redis-health.ts), com o mesmo prazo do controller.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_PROBES,
      inject: [ENV],
      useFactory: (env: Pick<Env, "DATABASE_URL" | "REDIS_URL">): ReadinessProbes => ({
        postgres: () => pingPostgres(env.DATABASE_URL, DEFAULT_READY_TIMEOUT_MS),
        redis: () => pingRedis(env.REDIS_URL, DEFAULT_READY_TIMEOUT_MS),
      }),
    },
  ],
})
export class HealthModule {}
