import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadModelsConfig } from "./models-config.js";

const path = fileURLToPath(new URL("../../../config/models.yaml", import.meta.url));

describe("loadModelsConfig", () => {
  it("carrega o models.yaml real", () => {
    const cfg = loadModelsConfig(path);
    expect(cfg.roles.reasoning.fallback).toHaveLength(2);
    expect(cfg.roles.conversational.primary).toContain("gpt-oss-120b");
    expect(cfg.embeddings.dimensions).toBe(1024);
    expect(cfg.limits).toEqual({ rpm: 20, timeoutMs: 60000, temperature: 0.2 });
  });
});
