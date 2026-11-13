import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());

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
    EXECUTION_FEE_PCT: z.coerce.number().nonnegative().default(0.5),
    DEFAULT_RPM: z.coerce.number().int().positive().default(60),
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
  .transform((e) => ({ ...e, LLM_MODE: e.LLM_MODE ?? ("mock" as const) }));

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
