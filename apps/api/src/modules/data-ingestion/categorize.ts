/**
 * Categorização determinística das transações na ingestão (spec §5): sem LLM, só regras fixas.
 * Categoria que chega com o item nunca é sobrescrita; sem regra, o item fica sem categoria
 * (nada de "outros" inventado).
 */
import type { NormalizedTransaction } from "@carina/shared";

type Kind = NormalizedTransaction["kind"];

/** Categoria fixa por `kind`: vence qualquer palavra da descrição. */
const KIND_CATEGORY: Partial<Record<Kind, string>> = {
  buy: "investimento",
  sell: "investimento",
  dividend: "investimento",
  jcp: "investimento",
  tax: "impostos",
  fee: "tarifas",
};

/** Porta de `_RULES` (legacy/python/.../categorizer.py), na mesma ordem de categorias. */
const RULES: readonly (readonly [string, readonly string[]])[] = [
  ["investimento", ["corretora", "tesouro", "cdb", "fundo", "b3", "xp", "nuinvest"]],
  ["moradia", ["aluguel", "condominio", "iptu", "luz", "agua", "energia"]],
  ["alimentação", ["supermercado", "restaurante", "ifood", "mercado"]],
  ["transporte", ["uber", "99", "combustivel", "posto", "estacionamento"]],
  ["saúde", ["farmacia", "hospital", "consulta", "plano de saude"]],
  ["lazer", ["netflix", "spotify", "cinema", "viagem", "hotel"]],
];

/** Minúsculas, NFD e sem marcas combinantes: "FARMÁCIA" e "farmacia" se igualam. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const SHORT_WORD = 3;

/** Palavras curtas (`99`, `xp`, `luz`) só como palavra inteira; as demais por substring. */
function hasWord(haystack: string, word: string): boolean {
  if (word.length > SHORT_WORD) return haystack.includes(word);
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

export function categorize(description: string, kind: Kind): string | null {
  const byKind = KIND_CATEGORY[kind];
  if (byKind !== undefined) return byKind;
  const text = fold(description);
  for (const [category, words] of RULES) {
    if (words.some((w) => hasWord(text, w))) return category;
  }
  return null;
}

/** Mantém `category` quando presente e não vazia; senão infere. Sem regra, não define `category`. */
export function withInferredCategories(
  items: readonly NormalizedTransaction[],
): NormalizedTransaction[] {
  return items.map((item) => {
    if (item.category !== undefined && item.category !== "") return item;
    const inferred = categorize(item.description, item.kind);
    const base = { ...item };
    // `category` vazio é descartado: sem regra, o item segue sem categoria.
    delete base.category;
    return inferred === null ? base : { ...base, category: inferred };
  });
}
