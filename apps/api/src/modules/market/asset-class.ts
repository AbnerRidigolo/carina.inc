import type { Quote } from "@carina/shared";

/** Símbolo aceito antes de montar qualquer URL ou chave de cache. */
export const SYMBOL_RE = /^\^?[A-Z0-9]{1,12}$/;

/**
 * Heurística do sufixo numérico do ticker (portada do Python): 3 a 8 ação; 31 a 39 BDR; 11 fundo;
 * prefixo `^` índice; o resto, desconhecido.
 */
export function inferAssetClass(symbol: string): Quote["assetClass"] {
  if (symbol.startsWith("^")) return "index";
  const match = /^[A-Z]{4}(\d{1,2})$/.exec(symbol);
  if (!match) return "unknown";
  const suffix = Number(match[1]);
  if (suffix >= 3 && suffix <= 8) return "stock";
  if (suffix >= 31 && suffix <= 39) return "bdr";
  if (suffix === 11) return "fund";
  return "unknown";
}
