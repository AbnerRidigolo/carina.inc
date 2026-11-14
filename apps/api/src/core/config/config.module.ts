import { fileURLToPath } from "node:url";
import { type DynamicModule, Global, Module } from "@nestjs/common";
import { type Env, loadEnv } from "./env.js";
import { loadModelsConfig } from "./models-config.js";

export const ENV = Symbol("ENV");
export const MODELS_CONFIG = Symbol("MODELS_CONFIG");

// Resolve para apps/api/config/models.yaml tanto a partir de src/ quanto de dist/.
const defaultModelsPath = fileURLToPath(new URL("../../../config/models.yaml", import.meta.url));

const modelsConfigProvider = {
  provide: MODELS_CONFIG,
  useFactory: () => loadModelsConfig(process.env["MODELS_CONFIG_PATH"] ?? defaultModelsPath),
};

/** Variante com o Env já validado (seed e scripts que recebem o ambiente por parâmetro). */
@Module({})
class FixedEnvConfigModule {}

/** Lê e valida `process.env` uma vez, ao instanciar (o processo falha no boot se faltar algo). */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv(process.env) }, modelsConfigProvider],
  exports: [ENV, MODELS_CONFIG],
})
export class ConfigModule {
  /** Mesmo contrato (ENV e MODELS_CONFIG globais), com um Env dado em vez de `process.env`. */
  static forEnv(env: Env): DynamicModule {
    return {
      module: FixedEnvConfigModule,
      global: true,
      providers: [{ provide: ENV, useValue: env }, modelsConfigProvider],
      exports: [ENV, MODELS_CONFIG],
    };
  }
}
