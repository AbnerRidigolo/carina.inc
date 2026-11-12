import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const min = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://carina_app:x@localhost:5432/carina",
  MIGRATION_DATABASE_URL: "postgres://carina_migrator:x@localhost:5432/carina",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadEnv", () => {
  it("usa LLM_MODE mock por padrão e aplica defaults", () => {
    const env = loadEnv(min);
    expect(env.LLM_MODE).toBe("mock");
    expect(env.PORT).toBe(3000);
    expect(env.EXECUTION_FEE_PCT).toBe(0.5);
    expect(env.DEFAULT_RPM).toBe(60);
    expect(env.APPROVAL_TTL_HOURS).toBe(24);
    expect(env.WEB_ORIGIN).toBe("http://localhost:5173");
    expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(env.WORKERS_ENABLED).toBe("true");
  });

  it('WORKERS_ENABLED aceita só "true" ou "false"', () => {
    expect(loadEnv({ ...min, WORKERS_ENABLED: "false" }).WORKERS_ENABLED).toBe("false");
    expect(loadEnv({ ...min, WORKERS_ENABLED: "true" }).WORKERS_ENABLED).toBe("true");
    for (const bad of ["0", "no", "TRUE", "yes"]) {
      expect(() => loadEnv({ ...min, WORKERS_ENABLED: bad }), bad).toThrow(/WORKERS_ENABLED/);
    }
  });

  it("exige OPENROUTER_API_KEY com LLM_MODE=live", () => {
    expect(() => loadEnv({ ...min, LLM_MODE: "live" })).toThrow(/OPENROUTER_API_KEY/);
    expect(loadEnv({ ...min, LLM_MODE: "live", OPENROUTER_API_KEY: "k" }).LLM_MODE).toBe("live");
  });

  it("falha sem DATABASE_URL", () => {
    expect(() => loadEnv({ ...min, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
});
