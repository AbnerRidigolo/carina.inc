/**
 * Fumaça MANUAL dos provedores LIVE (`pnpm --filter @carina/api market:smoke`, depois do build).
 * Não roda no CI nem em `pnpm test` (não é spec) e fica fora da cobertura (vitest.config.ts).
 *
 * Busca PETR4 na brapi.dev e os quatro indicadores do BCB SGS pela rede de verdade e imprime
 * símbolo, preço e hora. Serve para rodar UMA vez com rede e registrar respostas reais: as
 * fixtures dos provedores foram reconstruídas da documentação (o sandbox de desenvolvimento não
 * alcançava os provedores). Lê `BRAPI_TOKEN` (opcional) e as URLs-base do ambiente; nunca imprime
 * o token nem URLs completas (o logger dos provedores registra só host e motivo). Recusa, antes de
 * qualquer chamada, limites que não são inteiros positivos e token com URL base sem https (a
 * mesma regra do env.ts). Sai com código ≠ 0 se qualquer chamada falhar.
 */
import { pathToFileURL } from "node:url";
import { brapiUrlAllowsToken } from "../../core/config/env.js";
import { BcbProvider } from "./providers/bcb.provider.js";
import { BrapiProvider } from "./providers/brapi.provider.js";

/** Indicadores esperados (o provedor descarta em silêncio o que não valida). */
const SGS_EXPECTED = 4;

const nonEmpty = (v: string | undefined): string | undefined =>
  v === undefined || v.trim() === "" ? undefined : v.trim();

/** Inteiro positivo da variável (ou o padrão); senão lança com o nome, sem o valor. */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(nonEmpty(raw) ?? fallback);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} precisa ser inteiro positivo`);
  return value;
}

export async function smoke(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const timeoutMs = positiveInt("MARKET_FETCH_TIMEOUT_MS", env.MARKET_FETCH_TIMEOUT_MS, 8000);
  const maxBytes = positiveInt(
    "MARKET_MAX_RESPONSE_BYTES",
    env.MARKET_MAX_RESPONSE_BYTES,
    1_048_576,
  );
  const now = () => Date.now();
  const baseUrl = nonEmpty(env.BRAPI_BASE_URL) ?? "https://brapi.dev/api";
  const token = nonEmpty(env.BRAPI_TOKEN);
  if (!brapiUrlAllowsToken(baseUrl, token)) {
    throw new Error("BRAPI_BASE_URL precisa ser https quando BRAPI_TOKEN está definido");
  }

  const brapi = new BrapiProvider({
    baseUrl,
    token,
    timeoutMs,
    maxBytes,
    fetchImpl: fetch,
    now,
  });
  const bcb = new BcbProvider({
    baseUrl: nonEmpty(env.BCB_SGS_BASE_URL) ?? "https://api.bcb.gov.br/dados/serie",
    timeoutMs,
    maxBytes,
    fetchImpl: fetch,
    now,
  });

  const quotes = await brapi.fetchQuotes(["PETR4"]);
  if (quotes.length === 0) throw new Error("brapi: PETR4 não veio na resposta");
  for (const q of quotes) {
    console.log(`brapi  ${q.symbol}  R$ ${q.price}  atualizado em ${q.updatedAt}`);
  }

  const macro = await bcb.fetchMacro();
  if (macro.length < SGS_EXPECTED) {
    throw new Error(`BCB SGS: ${macro.length} de ${SGS_EXPECTED} indicadores na resposta`);
  }
  for (const m of macro) {
    console.log(`bcb    ${m.code}  ${m.value} ${m.unit}  referência ${m.referenceDate}`);
  }
}

// Execução direta (`node dist/modules/market/smoke.js`); importar o módulo não roda a fumaça.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await smoke();
    console.log("OK");
  } catch (err) {
    console.error(`Fumaça falhou: ${err instanceof Error ? err.message : "erro desconhecido"}`);
    process.exit(1);
  }
}
