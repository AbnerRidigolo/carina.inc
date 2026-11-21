import { describe, expect, it } from "vitest";
import { brapiUrlAllowsToken, loadEnv } from "./env.js";

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

  it("IMPORT_PARSE_MAX_HEAP_MB: padrão 512, configurável, limites 64..16384", () => {
    expect(loadEnv(min).IMPORT_PARSE_MAX_HEAP_MB).toBe(512);
    expect(loadEnv({ ...min, IMPORT_PARSE_MAX_HEAP_MB: "2048" }).IMPORT_PARSE_MAX_HEAP_MB).toBe(
      2048,
    );
    expect(() => loadEnv({ ...min, IMPORT_PARSE_MAX_HEAP_MB: "32" })).toThrow(
      /IMPORT_PARSE_MAX_HEAP_MB/,
    );
    expect(() => loadEnv({ ...min, IMPORT_PARSE_MAX_HEAP_MB: "abc" })).toThrow(
      /IMPORT_PARSE_MAX_HEAP_MB/,
    );
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

  it("lotes e concorrência da brapi: padrão 1 e 1; limites 1..20 e 1..10", () => {
    const env = loadEnv(min);
    expect(env.MARKET_BRAPI_MAX_SYMBOLS_PER_CALL).toBe(1);
    expect(env.MARKET_PROVIDER_CONCURRENCY).toBe(1);
    const ok = loadEnv({
      ...min,
      MARKET_BRAPI_MAX_SYMBOLS_PER_CALL: "20",
      MARKET_PROVIDER_CONCURRENCY: "10",
    });
    expect(ok.MARKET_BRAPI_MAX_SYMBOLS_PER_CALL).toBe(20);
    expect(ok.MARKET_PROVIDER_CONCURRENCY).toBe(10);
    for (const bad of ["0", "21", "1.5", "x"]) {
      expect(() => loadEnv({ ...min, MARKET_BRAPI_MAX_SYMBOLS_PER_CALL: bad })).toThrow(
        /MARKET_BRAPI_MAX_SYMBOLS_PER_CALL/,
      );
    }
    for (const bad of ["0", "11"]) {
      expect(() => loadEnv({ ...min, MARKET_PROVIDER_CONCURRENCY: bad })).toThrow(
        /MARKET_PROVIDER_CONCURRENCY/,
      );
    }
  });

  it("orçamentos de chamadas ao provedor (rotas e preço): padrão 30/min, de 1 a 10000", () => {
    const env = loadEnv(min);
    expect(env.MARKET_PROVIDER_MAX_CALLS_PER_MIN).toBe(30);
    expect(env.MARKET_PRICE_MAX_CALLS_PER_MIN).toBe(30);
    for (const name of ["MARKET_PROVIDER_MAX_CALLS_PER_MIN", "MARKET_PRICE_MAX_CALLS_PER_MIN"]) {
      expect((loadEnv({ ...min, [name]: "10000" }) as Record<string, unknown>)[name]).toBe(10000);
      for (const bad of ["0", "10001", "2.5", "x"]) {
        expect(() => loadEnv({ ...min, [name]: bad })).toThrow(new RegExp(name));
      }
    }
  });

  it("MONITOR_*: padrões e limites", () => {
    const env = loadEnv(min);
    expect(env.MARKET_MONITOR_MAX_CALLS_PER_MIN).toBe(10);
    expect(env.MONITOR_INTERVAL_MS).toBe(600_000);
    expect(env.MONITOR_MAX_SYMBOLS_PER_TICK).toBe(10);
    expect(env.MONITOR_MOVE_THRESHOLD_PCT).toBe(5);
    const limits: [string, string[], string[]][] = [
      ["MARKET_MONITOR_MAX_CALLS_PER_MIN", ["1", "10000"], ["0", "10001", "2.5", "x"]],
      ["MONITOR_INTERVAL_MS", ["60000"], ["59999", "0", "1.5", "x"]],
      ["MONITOR_MAX_SYMBOLS_PER_TICK", ["1", "200"], ["0", "201", "2.5", "x"]],
      ["MONITOR_MOVE_THRESHOLD_PCT", ["1", "50"], ["0", "51", "2.5", "x"]],
    ];
    for (const [name, good, bad] of limits) {
      for (const v of good) {
        expect((loadEnv({ ...min, [name]: v }) as Record<string, unknown>)[name]).toBe(Number(v));
      }
      for (const v of bad) {
        expect(() => loadEnv({ ...min, [name]: v })).toThrow(new RegExp(name));
      }
    }
  });

  it("BRAPI_TOKEN definido exige BRAPI_BASE_URL https (o token não vai em claro)", () => {
    for (const url of ["http://brapi.dev/api", "http://localhost:8080/api"]) {
      expect(() => loadEnv({ ...min, BRAPI_TOKEN: "tok", BRAPI_BASE_URL: url })).toThrow(
        /BRAPI_BASE_URL: .*https/,
      );
      // Sem token, http segue aceito (ex.: um provedor falso local em teste).
      expect(loadEnv({ ...min, BRAPI_BASE_URL: url }).BRAPI_BASE_URL).toBe(url);
    }
    expect(
      loadEnv({ ...min, BRAPI_TOKEN: "tok", BRAPI_BASE_URL: "https://brapi.dev/api" }).BRAPI_TOKEN,
    ).toBe("tok");
    expect(brapiUrlAllowsToken("não é url", "tok")).toBe(false);
    expect(brapiUrlAllowsToken("não é url", undefined)).toBe(true);
    // Token vazio conta como ausente.
    expect(
      loadEnv({ ...min, BRAPI_TOKEN: "", BRAPI_BASE_URL: "http://x.test/api" }).BRAPI_TOKEN,
    ).toBeUndefined();
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
