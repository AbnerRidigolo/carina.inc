import { Module } from "@nestjs/common";
import { RedisModule } from "../../core/redis/redis.module.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { MockResponderRegistry } from "./mock-models.js";
import { ModelFactory } from "./model-factory.js";

const systemClock: Clock = () => Date.now();

/**
 * Camada de modelos. Importa o Redis (limitador por provedor); ENV e MODELS_CONFIG vêm do
 * ConfigModule global. O CLOCK é próprio daqui (mesmo token do LimitsModule, sem importá-lo, para
 * não arrastar o RateLimitGuard global): testes o substituem com `overrideProvider(CLOCK)`.
 * O `MockResponderRegistry` é exportado: os módulos de agentes registram seus responders nele.
 */
@Module({
  imports: [RedisModule],
  providers: [{ provide: CLOCK, useValue: systemClock }, MockResponderRegistry, ModelFactory],
  exports: [ModelFactory, MockResponderRegistry],
})
export class LlmModule {}
