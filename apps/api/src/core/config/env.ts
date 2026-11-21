import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());

/**
 * Com token da brapi, a URL base precisa ser `https:` (o token vai no cabeçalho `Authorization` e
 * iria em claro). Sem token, `http:` continua aceito. Também usada pela fumaça manual (smoke.ts).
 */
export function brapiUrlAllowsToken(baseUrl: string, token: string | undefined): boolean {
  if (token === undefined) return true;
  try {
    return new URL(baseUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    /**
     * Papel dono (carina_migrator). Só o seed o usa (tenant e chaves de demo); `prisma migrate
     * deploy` lê a variável direto (prisma.config.ts). Opcional de propósito: a API e o worker
     * rodam sem a credencial do migrator (só carina_app, spec §5.3).
     */
    MIGRATION_DATABASE_URL: optionalSecret,
    REDIS_URL: z.string().min(1),
    /**
     * `mock` (padrão fora de produção) ou `live`. Com NODE_ENV=production é OBRIGATÓRIA: uma API
     * de produção nunca cai em modelos falsos por esquecimento (o docker compose de demo define
     * `mock` explicitamente).
     */
    LLM_MODE: z.preprocess(emptyToUndefined, z.enum(["live", "mock"]).optional()),
    OPENROUTER_API_KEY: optionalSecret,
    GROQ_API_KEY: optionalSecret,
    NVIDIA_API_KEY: optionalSecret,
    OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
    GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
    NVIDIA_BASE_URL: z.string().url().default("https://integrate.api.nvidia.com/v1"),
    /**
     * `mock` (padrão fora de produção) ou `live` (brapi.dev + BCB SGS). Com NODE_ENV=production é
     * OBRIGATÓRIA, como o LLM_MODE.
     */
    MARKET_MODE: z.preprocess(emptyToUndefined, z.enum(["live", "mock"]).optional()),
    /**
     * Token da brapi.dev (opcional: sem ele só PETR4, MGLU3, VALE3 e ITUB4 respondem; ver a
     * documentação da brapi). Com token, `BRAPI_BASE_URL` precisa ser `https:`.
     */
    BRAPI_TOKEN: optionalSecret,
    BRAPI_BASE_URL: z.string().url().default("https://brapi.dev/api"),
    BCB_SGS_BASE_URL: z.string().url().default("https://api.bcb.gov.br/dados/serie"),
    /** Timeout de cada chamada ao provedor de mercado (ms). */
    MARKET_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(8000),
    /** Tamanho máximo aceito da resposta do provedor (bytes). */
    MARKET_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1).default(1_048_576),
    /**
     * Símbolos por requisição de cotação à brapi. Padrão 1: o plano gratuito aceita 1 ativo por
     * requisição (os pagos aceitam mais; ver a documentação de planos da brapi). Até 20, o teto
     * de símbolos de uma consulta.
     */
    MARKET_BRAPI_MAX_SYMBOLS_PER_CALL: z.coerce.number().int().min(1).max(20).default(1),
    /** Requisições simultâneas à brapi por processo (fila no processo). Padrão 1 (plano gratuito). */
    MARKET_PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
    /**
     * Orçamento global de requisições ao provedor por minuto (janela fixa, contador no Redis) para
     * as rotas `/api/market/*`. Esgotado → 503 com Retry-After, sem cobrança. Uma consulta de N
     * símbolos fora do cache consome ceil(N / MARKET_BRAPI_MAX_SYMBOLS_PER_CALL) unidades.
     */
    MARKET_PROVIDER_MAX_CALLS_PER_MIN: z.coerce.number().int().min(1).max(10_000).default(30),
    /** Orçamento separado (por minuto) para o preço de servidor das ordens (`priceFor`). */
    MARKET_PRICE_MAX_CALLS_PER_MIN: z.coerce.number().int().min(1).max(10_000).default(30),
    /**
     * Orçamento separado (por minuto) para o monitor de carteira (`monitorQuotes`): nunca esgota o
     * das rotas nem o do preço. Esgotado → o ciclo do monitor para de cotar e retoma no seguinte.
     */
    MARKET_MONITOR_MAX_CALLS_PER_MIN: z.coerce.number().int().min(1).max(10_000).default(10),
    /** Intervalo (ms) entre ciclos do monitor de carteira. Padrão 10 min; mínimo 1 min. */
    MONITOR_INTERVAL_MS: z.coerce.number().int().min(60_000).default(600_000),
    /** Símbolos cotados por ciclo do monitor (rodízio sobre a carteira de todos os tenants). */
    MONITOR_MAX_SYMBOLS_PER_TICK: z.coerce.number().int().min(1).max(200).default(20),
    /** Variação diária (%, em módulo) a partir da qual o monitor gera alerta. */
    MONITOR_MOVE_THRESHOLD_PCT: z.coerce.number().int().min(1).max(50).default(5),
    /**
     * Idade máxima de uma cotação com o mercado aberto (ms). Padrão 5 min; no live precisa ser pelo
     * menos o atraso do plano da brapi (ex.: ~35 min no gratuito), senão toda ordem em pregão é
     * recusada como `price_stale`.
     */
    MARKET_QUOTE_MAX_AGE_MS: z.coerce.number().int().min(1).default(300_000),
    /**
     * Heap máxima (MB) da thread de parse da importação (`resourceLimits`). Estourar → job
     * `failed`/`limit_exceeded`. Planilhas de poucos MB podem passar de 512 MB ao expandir; suba
     * só se o container tiver memória sobrando para isso além do resto do worker.
     */
    IMPORT_PARSE_MAX_HEAP_MB: z.coerce.number().int().min(64).max(16_384).default(512),
    /** Idade máxima (dias) de uma cotação com o mercado fechado (fins de semana e feriados). */
    MARKET_CLOSED_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(5),
    EXECUTION_FEE_PCT: z.coerce.number().nonnegative().default(0.5),
    APPROVAL_TTL_HOURS: z.coerce.number().positive().default(24),
    /** Única origem aceita pelo CORS da API (o frontend). Sem curinga. */
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    /** Nível do pino. `silent` desliga os logs (testes). */
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    /** Liga os workers de fundo (consumidores de streams, ex.: Sync) neste processo. */
    WORKERS_ENABLED: z.enum(["true", "false"]).default("true"),
    /**
     * Vida máxima de uma conexão WebSocket do chat (ms). Ao vencer, o servidor fecha com 4401 (depois
     * de terminar o turno em andamento) e o cliente emite um ticket novo.
     */
    WS_MAX_CONNECTION_MS: z.coerce.number().int().min(1000).max(86_400_000).default(1_800_000),
    /**
     * Cache da revalidação da chave por id (ms) antes de cada turno de chat. É a janela MÁXIMA entre
     * revogar a chave / tirar o escopo `chat` / suspender o tenant e o efeito num socket aberto.
     */
    API_KEY_REVALIDATE_TTL_MS: z.coerce.number().int().min(0).max(60_000).default(60_000),
  })
  .refine((e) => e.LLM_MODE !== "live" || e.OPENROUTER_API_KEY !== undefined, {
    path: ["OPENROUTER_API_KEY"],
    message: "OPENROUTER_API_KEY é obrigatória com LLM_MODE=live",
  })
  .refine((e) => e.NODE_ENV !== "production" || e.LLM_MODE !== undefined, {
    path: ["LLM_MODE"],
    message: "LLM_MODE (live|mock) é obrigatória com NODE_ENV=production",
  })
  .refine((e) => brapiUrlAllowsToken(e.BRAPI_BASE_URL, e.BRAPI_TOKEN), {
    path: ["BRAPI_BASE_URL"],
    message: "BRAPI_BASE_URL precisa ser https quando BRAPI_TOKEN está definido",
  })
  .refine((e) => e.NODE_ENV !== "production" || e.MARKET_MODE !== undefined, {
    path: ["MARKET_MODE"],
    message: "MARKET_MODE (live|mock) é obrigatória com NODE_ENV=production",
  })
  .transform((e) => ({
    ...e,
    LLM_MODE: e.LLM_MODE ?? ("mock" as const),
    MARKET_MODE: e.MARKET_MODE ?? ("mock" as const),
  }));

export type Env = z.infer<typeof EnvSchema>;

/** Valida as variáveis de ambiente; lança com a lista de variáveis inválidas (sem valores). */
export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Configuração de ambiente inválida: ${issues}`);
  }
  return parsed.data;
}
