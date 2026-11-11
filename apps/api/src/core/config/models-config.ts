import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const Role = z.object({ primary: z.string().min(1), fallback: z.array(z.string().min(1)) });

export const ModelsConfigSchema = z.object({
  roles: z.object({ conversational: Role, reasoning: Role }),
  embeddings: z.object({ primary: z.string().min(1), dimensions: z.literal(1024) }),
  limits: z.object({
    rpm: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
  }),
});

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export function loadModelsConfig(path: string): ModelsConfig {
  const parsed = ModelsConfigSchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`models.yaml inválido: ${issues}`);
  }
  return parsed.data;
}
