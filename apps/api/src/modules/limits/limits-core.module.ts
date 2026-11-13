import { Module } from "@nestjs/common";
import { RedisModule } from "../../core/redis/redis.module.js";
import { CLOCK, type Clock } from "./clock.js";
import { QuotaService } from "./quota.service.js";

const systemClock: Clock = () => Date.now();

/**
 * CLOCK e QuotaService, SEM o RateLimitGuard global: para módulos de serviço e para o
 * WorkerModule. O LimitsModule (processo HTTP) acrescenta o guard.
 */
@Module({
  imports: [RedisModule],
  providers: [{ provide: CLOCK, useValue: systemClock }, QuotaService],
  exports: [CLOCK, QuotaService],
})
export class LimitsCoreModule {}
