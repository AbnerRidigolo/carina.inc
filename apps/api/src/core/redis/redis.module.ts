import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { ENV } from "../config/config.module.js";
import type { Env } from "../config/env.js";
import { CacheService } from "./cache.service.js";
import { REDIS } from "./redis.tokens.js";
import { StreamsService } from "./streams.service.js";

/** Depende do ENV do ConfigModule (global). Uma conexão de comandos compartilhada. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Pick<Env, "REDIS_URL">) => new Redis(env.REDIS_URL),
    },
    CacheService,
    StreamsService,
  ],
  exports: [REDIS, CacheService, StreamsService],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
export { REDIS } from "./redis.tokens.js";
