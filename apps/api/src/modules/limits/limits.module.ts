import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { RedisModule } from "../../core/redis/redis.module.js";
import { CLOCK, type Clock } from "./clock.js";
import { QuotaService } from "./quota.service.js";
import { RateLimitGuard } from "./rate-limit.guard.js";

const systemClock: Clock = () => Date.now();

/**
 * Limites: RateLimitGuard global e QuotaService. Importe este módulo DEPOIS do TenancyModule: os
 * guards globais rodam na ordem de registro, e o RateLimitGuard precisa de `req.tenant` já
 * preenchido pelo ApiKeyGuard (fora de ordem ele falha fechado com 401, nunca deixa passar).
 */
@Module({
  imports: [RedisModule],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    QuotaService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [CLOCK, QuotaService],
})
export class LimitsModule {}
