import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { RedisModule } from "../../core/redis/redis.module.js";
import { LimitsCoreModule } from "./limits-core.module.js";
import { RateLimitGuard } from "./rate-limit.guard.js";

/**
 * Limites: RateLimitGuard global (mais CLOCK e QuotaService, reexportados do LimitsCoreModule).
 * Importe este módulo DEPOIS do TenancyModule: os guards globais rodam na ordem de registro, e o
 * RateLimitGuard precisa de `req.tenant` já preenchido pelo ApiKeyGuard (fora de ordem ele falha
 * fechado com 401, nunca deixa passar).
 */
@Module({
  imports: [RedisModule, LimitsCoreModule],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
  exports: [LimitsCoreModule],
})
export class LimitsModule {}
