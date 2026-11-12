/**
 * Constantes do gerador sintético (spec §6.4): perfis, quadro de alocação e universo de ativos.
 * Todos os valores monetários estão em centavos inteiros (nunca ponto flutuante).
 */

export const PROFILE_NAMES = ["conservador", "moderado", "arrojado"] as const;
export type Profile = (typeof PROFILE_NAMES)[number];

/** Grupos do quadro de alocação (renda fixa e Tesouro formam um grupo só). */
export const GROUPS = ["rendaFixa", "fundos", "fiis", "acoes", "caixa"] as const;
export type Group = (typeof GROUPS)[number];

export interface ProfileSpec {
  /** Patrimônio total, em centavos. */
  readonly patrimonyCents: number;
  /** Alocação alvo em % do patrimônio (soma 100). O seed varia cada grupo em até ±3 p.p. */
  readonly allocationPct: Readonly<Record<Group, number>>;
}

export const PROFILES: Readonly<Record<Profile, ProfileSpec>> = {
  conservador: {
    patrimonyCents: 150_000_000,
    allocationPct: { rendaFixa: 70, fundos: 10, fiis: 10, acoes: 5, caixa: 5 },
  },
  moderado: {
    patrimonyCents: 400_000_000,
    allocationPct: { rendaFixa: 45, fundos: 15, fiis: 15, acoes: 20, caixa: 5 },
  },
  arrojado: {
    patrimonyCents: 1_200_000_000,
    allocationPct: { rendaFixa: 20, fundos: 10, fiis: 15, acoes: 50, caixa: 5 },
  },
};

/**
 * Variação máxima do seed sobre cada alvo, em p.p. Fica um pouco abaixo de 3 para sobrar folga ao
 * arredondamento (cotas inteiras empurram poucos reais para o caixa).
 */
export const MAX_ALLOCATION_DELTA_PP = 2.9;

/** Salário mensal: 1,5% do patrimônio (15 por mil). */
export const SALARY_PER_MILLE = 15;

export const INSTITUTIONS = ["XP", "BTG", "Itaú", "Nubank"] as const;

export interface StockSpec {
  readonly code: string;
  readonly name: string;
  readonly priceCents: number;
  /** Dividend yield anual, em pontos-base (1 bp = 0,01%). */
  readonly yieldBps: number;
  /** Parte do provento anual paga como JCP, em pontos-base de 10000 (0 = só dividendos). */
  readonly jcpShareBps: number;
}

export const STOCKS: readonly StockSpec[] = [
  { code: "PETR4", name: "Petrobras PN", priceCents: 3_850, yieldBps: 1_400, jcpShareBps: 0 },
  { code: "VALE3", name: "Vale ON", priceCents: 6_240, yieldBps: 800, jcpShareBps: 0 },
  { code: "ITUB4", name: "Itaú Unibanco PN", priceCents: 3_410, yieldBps: 550, jcpShareBps: 3_000 },
  {
    code: "BBAS3",
    name: "Banco do Brasil ON",
    priceCents: 2_760,
    yieldBps: 900,
    jcpShareBps: 4_000,
  },
  { code: "WEGE3", name: "WEG ON", priceCents: 5_180, yieldBps: 150, jcpShareBps: 5_000 },
  { code: "PRIO3", name: "PRIO ON", priceCents: 4_570, yieldBps: 100, jcpShareBps: 0 },
];

export interface FiiSpec {
  readonly code: string;
  readonly name: string;
  readonly priceCents: number;
  /** Rendimento mensal sobre o valor da posição, em pontos-base. */
  readonly monthlyYieldBps: number;
}

export const FIIS: readonly FiiSpec[] = [
  { code: "HGLG11", name: "CSHG Logística FII", priceCents: 16_200, monthlyYieldBps: 75 },
  { code: "KNRI11", name: "Kinea Renda Imobiliária FII", priceCents: 15_850, monthlyYieldBps: 70 },
  { code: "MXRF11", name: "Maxi Renda FII", priceCents: 1_040, monthlyYieldBps: 95 },
  { code: "XPML11", name: "XP Malls FII", priceCents: 10_780, monthlyYieldBps: 85 },
];

export interface FixedIncomeSpec {
  readonly slug: string;
  readonly assetClass: "tesouro" | "renda_fixa";
  readonly name: string;
  /** Peso relativo dentro do grupo renda fixa + Tesouro (o seed varia cada um em 70% a 130%). */
  readonly weight: number;
}

export const FIXED_INCOME: readonly FixedIncomeSpec[] = [
  { slug: "selic-2029", assetClass: "tesouro", name: "Tesouro Selic 2029", weight: 30 },
  { slug: "ipca-2035", assetClass: "tesouro", name: "Tesouro IPCA+ 2035", weight: 25 },
  { slug: "cdb", assetClass: "renda_fixa", name: "CDB 110% CDI", weight: 20 },
  { slug: "lci", assetClass: "renda_fixa", name: "LCI 95% CDI", weight: 13 },
  { slug: "lca", assetClass: "renda_fixa", name: "LCA 94% CDI", weight: 12 },
];

export interface FundSpec {
  readonly slug: string;
  readonly name: string;
  readonly weight: number;
  /** Valor da cota em centavos (para derivar a quantidade de cotas). */
  readonly quotaCents: number;
}

export const FUNDS: readonly FundSpec[] = [
  { slug: "multimercado-macro", name: "Fundo Multimercado Macro", weight: 40, quotaCents: 284_150 },
  { slug: "rf-credito-privado", name: "Fundo RF Crédito Privado", weight: 35, quotaCents: 153_720 },
  {
    slug: "multimercado-long-short",
    name: "Fundo Multimercado Long Short",
    weight: 25,
    quotaCents: 96_480,
  },
];

/** Onde cada classe costuma ficar custodiada (o seed escolhe uma por ativo). */
export const CUSTODY: Readonly<Record<string, readonly string[]>> = {
  acao: ["XP", "BTG"],
  fii: ["XP", "BTG"],
  tesouro: ["XP", "BTG", "Itaú"],
  renda_fixa: ["XP", "BTG", "Itaú", "Nubank"],
  fundo: ["XP", "BTG", "Itaú"],
};

export const CASH_ACCOUNTS = [
  { slug: "itau", institution: "Itaú", name: "Conta corrente Itaú", shareBps: 6_000 },
  { slug: "nubank", institution: "Nubank", name: "Caixinha Nubank", shareBps: 4_000 },
] as const;

/**
 * Despesas recorrentes mensais: percentual do salário em pontos-base (de 10000), conta e cartão.
 * Cada lançamento varia ±5% sobre o valor base conforme o seed.
 */
export const RECURRING_EXPENSES = [
  {
    slug: "moradia",
    category: "moradia",
    description: "Aluguel e condomínio",
    bps: 1_800,
    institution: "Itaú",
    account: "Conta corrente",
  },
  {
    slug: "saude",
    category: "saúde",
    description: "Plano de saúde",
    bps: 600,
    institution: "Itaú",
    account: "Conta corrente",
  },
  {
    slug: "educacao",
    category: "educação",
    description: "Mensalidade escolar",
    bps: 800,
    institution: "Itaú",
    account: "Conta corrente",
  },
  {
    slug: "alimentacao",
    category: "alimentação",
    description: "Supermercado e restaurantes",
    bps: 700,
    institution: "Nubank",
    account: "Cartão de crédito",
  },
  {
    slug: "transporte",
    category: "transporte",
    description: "Combustível e aplicativos",
    bps: 300,
    institution: "Nubank",
    account: "Cartão de crédito",
  },
  {
    slug: "lazer",
    category: "lazer",
    description: "Streaming, viagens e lazer",
    bps: 400,
    institution: "Nubank",
    account: "Cartão de crédito",
  },
] as const;

/** Aporte mensal em ativos: percentual do salário, em pontos-base. */
export const CONTRIBUTION_BPS = 2_000;

/** Compra parcelada em 10x: valor total como percentual do salário, em pontos-base. */
export const INSTALMENT_PURCHASE_BPS = 12_000;
export const INSTALMENT_COUNT = 10;
