import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * Limite do corpo JSON. O padrão do Express (100 KB) rejeita com 413 um lote de 1.000 itens de
 * ingestão (~250 KB); 5 MB deixa folga para textos longos e continua barrando abuso.
 */
export const JSON_BODY_LIMIT = "5mb";

/** Aplique no bootstrap (main.ts) e no app de teste, antes de `listen`/`init`. */
export function configureBodyParser(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
}
