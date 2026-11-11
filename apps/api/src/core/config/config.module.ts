import { fileURLToPath } from "node:url";
import { Global, Module } from "@nestjs/common";
import { loadEnv } from "./env.js";
import { loadModelsConfig } from "./models-config.js";

export const ENV = Symbol("ENV");
export const MODELS_CONFIG = Symbol("MODELS_CONFIG");

// Resolve para apps/api/config/models.yaml tanto a partir de src/ quanto de dist/.
const defaultModelsPath = fileURLToPath(new URL("../../../config/models.yaml", import.meta.url));

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv(process.env) },
    {
      provide: MODELS_CONFIG,
      useFactory: () => loadModelsConfig(process.env["MODELS_CONFIG_PATH"] ?? defaultModelsPath),
    },
  ],
  exports: [ENV, MODELS_CONFIG],
})
export class ConfigModule {}
