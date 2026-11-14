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
    expect(env.APPROVAL_TTL_HOURS).toBe(24);
    expect(env.WEB_ORIGIN).toBe("http://localhost:5173");
    expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(env.WORKERS_ENABLED).toBe("true");
    expect(env.WS_MAX_CONNECTION_MS).toBe(1_800_000);
    expect(env.API_KEY_REVALIDATE_TTL_MS).toBe(60_000);
  });

  it("MARKET_MODE: mock por padrão fora de produção e defaults de mercado", () => {
    const env = loadEnv(min);
    expect(env.MARKET_MODE).toBe("mock");
    expect(env.BRAPI_TOKEN).toBeUndefined();
    expect(env.BRAPI_BASE_URL).toBe("https://brapi.dev/api");
    expect(env.BCB_SGS_BASE_URL).toBe("https://api.bcb.gov.br/dados/serie");
    expect(env.MARKET_FETCH_TIMEOUT_MS).toBe(8000);
    expect(env.MARKET_MAX_RESPONSE_BYTES).toBe(1_048_576);
    expect(env.MARKET_QUOTE_MAX_AGE_MS).toBe(300_000);
    expect(env.MARKET_CLOSED_MAX_AGE_DAYS).toBe(5);
  });

  it("MARKET_MODE é obrigatória com NODE_ENV=production", () => {
    expect(() => loadEnv({ ...min, NODE_ENV: "production", LLM_MODE: "mock" })).toThrow(
      /MARKET_MODE/,
    );
    expect(
      loadEnv({ ...min, NODE_ENV: "production", LLM_MODE: "mock", MARKET_MODE: "live" })
        .MARKET_MODE,
    ).toBe("live");
  });

  it("MARKET_MODE só aceita live|mock; MARKET_FETCH_TIMEOUT_MS=0 falha", () => {
    expect(() => loadEnv({ ...min, MARKET_MODE: "fake" })).toThrow(/MARKET_MODE/);
    expect(() => loadEnv({ ...min, MARKET_FETCH_TIMEOUT_MS: "0" })).toThrow(
      /MARKET_FETCH_TIMEOUT_MS/,
    );
  });

  it("LOG_LEVEL: info por padrão; só níveis do pino (silent desliga)", () => {
    expect(loadEnv(min).LOG_LEVEL).toBe("info");
    expect(loadEnv({ ...min, LOG_LEVEL: "silent" }).LOG_LEVEL).toBe("silent");
    expect(() => loadEnv({ ...min, LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("MIGRATION_DATABASE_URL é opcional: a API e o worker não recebem a credencial do migrator", () => {
    const { MIGRATION_DATABASE_URL: _omit, ...withoutMigrator } = min;
    expect(_omit).toBeDefined();
    expect(loadEnv(withoutMigrator).MIGRATION_DATABASE_URL).toBeUndefined();
    expect(loadEnv({ ...withoutMigrator, MIGRATION_DATABASE_URL: "" }).MIGRATION_DATABASE_URL).toBe(
      undefined,
    );
  });

  it("WS_MAX_CONNECTION_MS: inteiro entre 1 s e 24 h", () => {
    expect(loadEnv({ ...min, WS_MAX_CONNECTION_MS: "1000" }).WS_MAX_CONNECTION_MS).toBe(1000);
    for (const bad of ["999", "86400001", "1.5", "abc", "-1"]) {
      expect(() => loadEnv({ ...min, WS_MAX_CONNECTION_MS: bad }), bad).toThrow(
        /WS_MAX_CONNECTION_MS/,
      );
    }
  });

  it("API_KEY_REVALIDATE_TTL_MS: de 0 a 60 s (a janela máxima entre a revogação e o efeito)", () => {
    expect(loadEnv({ ...min, API_KEY_REVALIDATE_TTL_MS: "0" }).API_KEY_REVALIDATE_TTL_MS).toBe(0);
    for (const bad of ["60001", "-1", "x"]) {
      expect(() => loadEnv({ ...min, API_KEY_REVALIDATE_TTL_MS: bad }), bad).toThrow(
        /API_KEY_REVALIDATE_TTL_MS/,
      );
    }
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

  it("produção exige LLM_MODE explícito (sem default silencioso para mock)", () => {
    const prod = { ...min, NODE_ENV: "production", MARKET_MODE: "mock" };
    expect(() => loadEnv(prod)).toThrow(/LLM_MODE/);
    expect(() => loadEnv({ ...prod, LLM_MODE: "" })).toThrow(/LLM_MODE/);
    expect(loadEnv({ ...prod, LLM_MODE: "mock" }).LLM_MODE).toBe("mock");
    expect(loadEnv({ ...prod, LLM_MODE: "live", OPENROUTER_API_KEY: "k" }).LLM_MODE).toBe("live");
    // Fora de produção o padrão continua mock (desenvolvimento e testes sem chave).
    expect(loadEnv({ ...min, NODE_ENV: "development" }).LLM_MODE).toBe("mock");
    expect(loadEnv({ ...min, LLM_MODE: "" }).LLM_MODE).toBe("mock");
  });

  it("falha sem DATABASE_URL", () => {
    expect(() => loadEnv({ ...min, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
});
