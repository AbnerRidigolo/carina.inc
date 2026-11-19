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

interface Rule {
  category: string;
  /** Casam como palavra inteira (evita "luz" em "Luzia", "posto" em "imposto", "99" em "199"). */
  whole: readonly string[];
  /** Casam como trecho da descrição. */
  contains: readonly string[];
}

/**
 * Porta de `_RULES` (legacy/python/.../categorizer.py), na mesma ordem de categorias, com
 * `impostos` na frente e sem o `mercado` solto (casava "Mercado Livre" e "mercado financeiro").
 */
const RULES: readonly Rule[] = [
  { category: "impostos", whole: ["imposto", "impostos", "darf", "iof"], contains: [] },
  {
    category: "investimento",
    whole: ["cdb", "b3", "xp"],
    contains: ["corretora", "tesouro", "fundo", "nuinvest"],
  },
  {
    category: "moradia",
    whole: ["luz", "agua"],
    contains: ["aluguel", "condominio", "iptu", "energia"],
  },
  {
    category: "alimentação",
    whole: [],
    contains: ["supermercado", "mercadinho", "restaurante", "ifood"],
  },
  {
    category: "transporte",
    whole: ["uber", "99", "posto"],
    contains: ["combustivel", "estacionamento"],
  },
  {
    category: "saúde",
    whole: [],
    contains: ["farmacia", "hospital", "consulta", "plano de saude"],
  },
  { category: "lazer", whole: [], contains: ["netflix", "spotify", "cinema", "viagem", "hotel"] },
];

/** Minúsculas, NFD e sem marcas combinantes: "FARMÁCIA" e "farmacia" se igualam. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function hasWholeWord(text: string, word: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "u").test(text);
}

function matches(text: string, rule: Rule): boolean {
  return (
    rule.whole.some((w) => hasWholeWord(text, w)) || rule.contains.some((w) => text.includes(w))
  );
}

export function categorize(description: string, kind: Kind): string | null {
  const byKind = KIND_CATEGORY[kind];
  if (byKind !== undefined) return byKind;
  const text = fold(description);
  for (const rule of RULES) {
    if (matches(text, rule)) return rule.category;
  }
  return null;
}

/** Mantém `category` quando presente e não vazia; senão infere. Sem regra, não define `category`. */
export function withInferredCategories(
  items: readonly NormalizedTransaction[],
): NormalizedTransaction[] {
  return items.map((item) => {
    if (item.category !== undefined && item.category.trim() !== "") return item;
    const inferred = categorize(item.description, item.kind);
    const base = { ...item };
    // `category` vazia ou só com espaços é descartada: sem regra, o item segue sem categoria.
    delete base.category;
    return inferred === null ? base : { ...base, category: inferred };
  });
}
