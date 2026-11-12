import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    MIGRATION_DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    LLM_MODE: z.enum(["live", "mock"]).default("mock"),
    OPENROUTER_API_KEY: optionalSecret,
    GROQ_API_KEY: optionalSecret,
    NVIDIA_API_KEY: optionalSecret,
    OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
    GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
    NVIDIA_BASE_URL: z.string().url().default("https://integrate.api.nvidia.com/v1"),
    EXECUTION_FEE_PCT: z.coerce.number().nonnegative().default(0.5),
    DEFAULT_RPM: z.coerce.number().int().positive().default(60),
    APPROVAL_TTL_HOURS: z.coerce.number().positive().default(24),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    /** Liga os workers de fundo (consumidores de streams, ex.: Sync) neste processo. */
    WORKERS_ENABLED: z.enum(["true", "false"]).default("true"),
  })
  .refine((e) => e.LLM_MODE !== "live" || e.OPENROUTER_API_KEY !== undefined, {
    path: ["OPENROUTER_API_KEY"],
    message: "OPENROUTER_API_KEY é obrigatória com LLM_MODE=live",
  });

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
