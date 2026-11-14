/**
 * Provedor live de indicadores macro: SGS (Sistema Gerenciador de Séries Temporais) do Banco
 * Central, `GET {BCB_SGS_BASE_URL}/bcdata.sgs.{codigo}/dados/ultimos/1?formato=json`.
 *
 * Fonte do formato (consultada em 2026-11-14 por busca na web, porque o sandbox não resolve
 * api.bcb.gov.br): Portal de Dados Abertos do BCB (dadosabertos.bcb.gov.br, recursos
 * `json_serie-sgs-*`) e resposta pública indexada de api.bcb.gov.br. A resposta é um array
 * `[{ "data": "dd/MM/aaaa", "valor": "<decimal em texto>" }]`; série sem dado volta `[]`. Código de
 * série inválido responde 200 com página HTML (vira JSON inválido e `MarketDataUnavailableError`).
 * NÃO verificado contra uma resposta real (sem rede): as fixtures são reconstruídas nesse formato.
 * Séries, nomes e unidades seguem o `BcbProvider` do legado Python.
 */
import { MacroIndicatorSchema, type MacroIndicator } from "@carina/shared";
import { z } from "zod";
import { MarketDataUnavailableError } from "../../../core/errors/domain-errors.js";
import { Prisma } from "../../../generated/prisma/client.js";
import {
  buildProviderUrl,
  defaultMarketLogger,
  safeFetchJson,
  type MarketLogger,
} from "./safe-fetch.js";
import type { MacroProvider } from "./types.js";

const Decimal = Prisma.Decimal;

export const SGS_SERIES = [
  { code: "selic", id: 432, name: "Meta Selic", unit: "% a.a." },
  { code: "cdi", id: 4389, name: "CDI anualizado", unit: "% a.a." },
  { code: "ipca", id: 433, name: "IPCA (variação mensal)", unit: "% a.m." },
  { code: "ptax_usd", id: 1, name: "Dólar PTAX (venda)", unit: "BRL/USD" },
] as const;

type Series = (typeof SGS_SERIES)[number];

/** `ultimos/1` traz uma linha; um teto pequeno recusa respostas desproporcionais. */
const SgsResponseSchema = z.array(z.unknown()).max(10);
const SgsRowSchema = z.object({
  data: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
  valor: z.string().max(32),
});
/** Decimal em texto, com ponto ou vírgula, sem notação científica, até 12 dígitos inteiros. */
const SGS_VALUE_RE = /^-?\d{1,12}([.,]\d{1,12})?$/;

/** "05/11/2026" -> "2026-11-05", só se a data existe no calendário. */
function toIsoDate(text: string): string | null {
  const [dd, mm, yyyy] = text.split("/").map(Number);
  if (dd === undefined || mm === undefined || yyyy === undefined) return null;
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function toValue(text: string): string | null {
  const trimmed = text.trim();
  if (!SGS_VALUE_RE.test(trimmed)) return null;
  const d = new Decimal(trimmed.replace(",", ".")).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  return d.isZero() ? "0" : d.toFixed();
}

export interface BcbProviderOptions {
  /** `BCB_SGS_BASE_URL` (só da configuração). */
  baseUrl: string;
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  logger?: MarketLogger;
}

export class BcbProvider implements MacroProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: MarketLogger;

  constructor(private readonly opts: BcbProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logger = opts.logger ?? defaultMarketLogger();
  }

  /** As quatro séries em paralelo; série vazia ou com valor inválido é omitida; erro HTTP lança. */
  async fetchMacro(): Promise<MacroIndicator[]> {
    const results = await Promise.all(SGS_SERIES.map((series) => this.fetchSeries(series)));
    return results.filter((m): m is MacroIndicator => m !== null);
  }

  private async fetchSeries(series: Series): Promise<MacroIndicator | null> {
    const url = buildProviderUrl(
      this.opts.baseUrl,
      [`bcdata.sgs.${String(series.id)}`, "dados", "ultimos", "1"],
      { formato: "json" },
    );
    const body = await safeFetchJson(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.opts.timeoutMs,
      maxBytes: this.opts.maxBytes,
      logger: this.logger,
    });
    const rows = SgsResponseSchema.safeParse(body);
    if (!rows.success) {
      this.logger.warn({ msg: "Resposta do SGS fora do formato esperado", host: url.host });
      throw new MarketDataUnavailableError();
    }
    const last = rows.data.at(-1);
    if (last === undefined) return null;
    const row = SgsRowSchema.safeParse(last);
    if (!row.success) return null;
    const value = toValue(row.data.valor);
    const referenceDate = toIsoDate(row.data.data);
    if (value === null || referenceDate === null) return null;

    const checked = MacroIndicatorSchema.safeParse({
      code: series.code,
      name: series.name,
      value,
      unit: series.unit,
      referenceDate,
    });
    return checked.success ? checked.data : null;
  }
}
