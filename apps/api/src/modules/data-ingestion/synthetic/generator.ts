import type { NormalizedPosition, NormalizedTransaction } from "@carina/shared";
import type { FinancialDataProvider } from "../provider.js";
import {
  CASH_ACCOUNTS,
  CONTRIBUTION_BPS,
  CUSTODY,
  FIIS,
  FIXED_INCOME,
  FUNDS,
  GROUPS,
  INSTALMENT_COUNT,
  INSTALMENT_PURCHASE_BPS,
  MAX_ALLOCATION_DELTA_PP,
  PROFILES,
  RECURRING_EXPENSES,
  SALARY_PER_MILLE,
  STOCKS,
  type Group,
  type Profile,
} from "./profiles.js";

export type { Profile } from "./profiles.js";
export { PROFILE_NAMES } from "./profiles.js";

export interface SyntheticPortfolio {
  positions: NormalizedPosition[];
  transactions: NormalizedTransaction[];
}

/*
 * Módulo puro: sem banco, sem Nest, sem I/O, sem Math.random e sem relógio. Toda a saída é função
 * de (profile, seed, asOf). Dinheiro é sempre aritmética de centavos inteiros (Number, abaixo de
 * 2^53) formatada só na borda; datas usam aritmética civil explícita (sem Date, sem Intl).
 *
 * Convenção de sinal de `amountBrl` (fluxo de caixa do cliente): entradas (salário, proventos)
 * positivas; saídas (despesas, parcelas, compras de ativos) negativas.
 */

// ---------------------------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------------------------

/** mulberry32: PRNG de 32 bits; devolve números em [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Float em [0, 1). */
  float(): number {
    return this.next();
  }
  /** Inteiro em [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new RangeError("lista vazia");
    return item;
  }
}

// ---------------------------------------------------------------------------------------------
// Datas (calendário civil gregoriano, UTC implícito)
// ---------------------------------------------------------------------------------------------

interface Civil {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function parseIsoDate(value: string): Civil {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`asOf precisa ser YYYY-MM-DD: ${value}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new RangeError(`asOf não é uma data válida: ${value}`);
  }
  return { y, m, d };
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");
const formatDate = ({ y, m, d }: Civil): string => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;

/** Desloca (ano, mês) por `delta` meses; o dia não é tocado. */
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const index = y * 12 + (m - 1) + delta;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

/**
 * As 12 últimas ocorrências do dia `day` (1..28, existe em todo mês) em ou antes de `asOf`, em
 * ordem crescente, uma por mês consecutivo. Com `day` <= 28 não há dia inexistente nem cálculo de
 * fim de mês, e a mais antiga sempre cai depois de asOf menos 12 meses.
 */
function monthlyDates(asOf: Civil, day: number): Civil[] {
  if (day < 1 || day > 28) throw new RangeError(`dia fora de 1..28: ${day}`);
  const anchor = day <= asOf.d ? { y: asOf.y, m: asOf.m } : shiftMonth(asOf.y, asOf.m, -1);
  const out: Civil[] = [];
  for (let back = 11; back >= 0; back--) {
    const { y, m } = shiftMonth(anchor.y, anchor.m, -back);
    out.push({ y, m, d: day });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dinheiro e quantidades (centavos inteiros)
// ---------------------------------------------------------------------------------------------

/** 123456 -> "1234.56"; -5 -> "-0.05". Sempre 2 casas, sem notação científica. */
function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`centavos inválidos: ${cents}`);
  const abs = Math.abs(cents);
  const text = `${Math.trunc(abs / 100)}.${pad(abs % 100, 2)}`;
  return cents < 0 ? `-${text}` : text;
}

/** Quantidade inteira de micro-unidades (1e-6) como decimal de 6 casas. */
function formatMicro(micro: number): string {
  return `${Math.trunc(micro / 1_000_000)}.${pad(micro % 1_000_000, 6)}`;
}

/** Fração em pontos-base de 10000, com arredondamento para o inteiro mais próximo. */
function bps(cents: number, basisPoints: number): number {
  return Math.round((cents * basisPoints) / 10_000);
}

/** Variação seedada de ±`spreadBps` sobre um valor. */
function jitter(rng: Rng, cents: number, spreadBps: number): number {
  return Math.round((cents * (10_000 + rng.int(-spreadBps, spreadBps))) / 10_000);
}

/** Divide `total` (inteiro) proporcionalmente a `weights` pelo método do maior resto. */
function splitCents(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w, i) => ({
    i,
    base: Math.floor((total * w) / sum),
    rest: (total * w) % sum,
  }));
  let left = total - parts.reduce((a, p) => a + p.base, 0);
  const order = [...parts].sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const p of order) {
    if (left <= 0) break;
    p.base += 1;
    left -= 1;
  }
  return parts.map((p) => p.base);
}

// ---------------------------------------------------------------------------------------------
// Posições
// ---------------------------------------------------------------------------------------------

/**
 * Alocação por grupo em centavos (exceto o caixa, que fecha o patrimônio depois). Cada grupo varia
 * no máximo MAX_ALLOCATION_DELTA_PP p.p. sobre o alvo, com soma dos desvios zero.
 */
function groupTargets(profile: Profile, rng: Rng): Record<Exclude<Group, "caixa">, number> {
  const spec = PROFILES[profile];
  const raw = GROUPS.map(() => rng.float() * 2 - 1);
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const centered = raw.map((r) => r - mean);
  const maxAbs = Math.max(...centered.map(Math.abs));
  const scale = maxAbs > 1 ? 1 / maxAbs : 1;
  const cents = (group: Group, index: number): number => {
    const delta = (centered[index] ?? 0) * scale * MAX_ALLOCATION_DELTA_PP;
    return Math.round((spec.patrimonyCents * (spec.allocationPct[group] + delta)) / 100);
  };
  return {
    rendaFixa: cents("rendaFixa", 0),
    fundos: cents("fundos", 1),
    fiis: cents("fiis", 2),
    acoes: cents("acoes", 3),
  };
}

interface Holding {
  code: string;
  institution: string;
  quantity: number;
  valueCents: number;
}

interface PositionsResult {
  positions: NormalizedPosition[];
  stocks: Holding[];
  fiis: Holding[];
}

function buildPositions(profile: Profile, rng: Rng, asOf: string): PositionsResult {
  const { patrimonyCents } = PROFILES[profile];
  const targets = groupTargets(profile, rng);
  const positions: NormalizedPosition[] = [];

  /** Cotas inteiras ao preço fixo do ativo; o resíduo de arredondamento vai para o caixa. */
  const whole = (
    group: number,
    specs: readonly { code: string; priceCents: number }[],
    custody: readonly string[],
  ): Holding[] => {
    const weights = specs.map(() => rng.int(50, 150));
    return splitCents(group, weights).map((target, i) => {
      const spec = specs[i];
      if (!spec) throw new RangeError("índice de ativo inválido");
      const quantity = Math.max(1, Math.round(target / spec.priceCents));
      return {
        code: spec.code,
        institution: rng.pick(custody),
        quantity,
        valueCents: quantity * spec.priceCents,
      };
    });
  };

  const stocks = whole(targets.acoes, STOCKS, CUSTODY["acao"] ?? []);
  stocks.forEach((h, i) => {
    positions.push({
      externalId: `pos-acao-${h.code}`,
      institution: h.institution,
      kind: "investment",
      assetClass: "acao",
      assetCode: h.code,
      name: STOCKS[i]?.name ?? h.code,
      quantity: String(h.quantity),
      valueBrl: formatCents(h.valueCents),
      asOf,
    });
  });

  const fiis = whole(targets.fiis, FIIS, CUSTODY["fii"] ?? []);
  fiis.forEach((h, i) => {
    positions.push({
      externalId: `pos-fii-${h.code}`,
      institution: h.institution,
      kind: "investment",
      assetClass: "fii",
      assetCode: h.code,
      name: FIIS[i]?.name ?? h.code,
      quantity: String(h.quantity),
      valueBrl: formatCents(h.valueCents),
      asOf,
    });
  });

  const fixedWeights = FIXED_INCOME.map((f) => Math.round(f.weight * (70 + rng.int(0, 60))));
  splitCents(targets.rendaFixa, fixedWeights).forEach((cents, i) => {
    const spec = FIXED_INCOME[i];
    if (!spec) throw new RangeError("índice de renda fixa inválido");
    positions.push({
      externalId: `pos-${spec.assetClass}-${spec.slug}`,
      institution: rng.pick(CUSTODY[spec.assetClass] ?? []),
      kind: "investment",
      assetClass: spec.assetClass,
      name: spec.name,
      valueBrl: formatCents(cents),
      asOf,
    });
  });

  const fundWeights = FUNDS.map((f) => Math.round(f.weight * (70 + rng.int(0, 60))));
  splitCents(targets.fundos, fundWeights).forEach((cents, i) => {
    const spec = FUNDS[i];
    if (!spec) throw new RangeError("índice de fundo inválido");
    positions.push({
      externalId: `pos-fundo-${spec.slug}`,
      institution: rng.pick(CUSTODY["fundo"] ?? []),
      kind: "investment",
      assetClass: "fundo",
      name: spec.name,
      quantity: formatMicro(Math.round((cents * 1_000_000) / spec.quotaCents)),
      valueBrl: formatCents(cents),
      asOf,
    });
  });

  // O caixa fecha o patrimônio em centavos exatos (absorve o resíduo das cotas inteiras).
  const invested = positions.reduce((acc, p) => acc + toCents(p.valueBrl), 0);
  const cash = patrimonyCents - invested;
  const cashParts = splitCents(
    cash,
    CASH_ACCOUNTS.map((c) => c.shareBps),
  );
  CASH_ACCOUNTS.forEach((account, i) => {
    positions.push({
      externalId: `pos-caixa-${account.slug}`,
      institution: account.institution,
      kind: "cash",
      assetClass: "caixa",
      name: account.name,
      valueBrl: formatCents(cashParts[i] ?? 0),
      asOf,
    });
  });

  return { positions, stocks, fiis };
}

/** "1234.56" -> 123456 (só para textos que o próprio gerador formatou). */
function toCents(money: string): number {
  const negative = money.startsWith("-");
  const [int = "0", frac = "00"] = (negative ? money.slice(1) : money).split(".");
  const value = Number(int) * 100 + Number(frac);
  return negative ? -value : value;
}

// ---------------------------------------------------------------------------------------------
// Transações
// ---------------------------------------------------------------------------------------------

function buildTransactions(
  profile: Profile,
  rng: Rng,
  asOfDate: Civil,
  stocks: readonly Holding[],
  fiis: readonly Holding[],
): NormalizedTransaction[] {
  const salaryCents = Math.floor((PROFILES[profile].patrimonyCents * SALARY_PER_MILLE) / 1000);
  const txns: NormalizedTransaction[] = [];
  const id = (date: Civil, slug: string): string =>
    `txn-${pad(date.y, 4)}-${pad(date.m, 2)}-${slug}`;

  // Salário: 1,5% do patrimônio por mês.
  for (const date of monthlyDates(asOfDate, rng.int(1, 10))) {
    txns.push({
      externalId: id(date, "salario"),
      institution: "Itaú",
      account: "Conta corrente",
      date: formatDate(date),
      description: "Salário",
      amountBrl: formatCents(salaryCents),
      kind: "credit",
      category: "salário",
    });
  }

  // Seis despesas recorrentes (±5% sobre o valor-base a cada mês).
  for (const expense of RECURRING_EXPENSES) {
    const base = bps(salaryCents, expense.bps);
    for (const date of monthlyDates(asOfDate, rng.int(1, 28))) {
      txns.push({
        externalId: id(date, expense.slug),
        institution: expense.institution,
        account: expense.account,
        date: formatDate(date),
        description: expense.description,
        amountBrl: formatCents(-Math.max(1, jitter(rng, base, 500))),
        kind: "debit",
        category: expense.category,
      });
    }
  }

  // Compra parcelada em 10x: as 10 parcelas cabem na janela (a série tem 12 meses).
  {
    const total = bps(salaryCents, INSTALMENT_PURCHASE_BPS);
    const each = Math.floor(total / INSTALMENT_COUNT);
    const remainder = total - each * INSTALMENT_COUNT;
    const dates = monthlyDates(asOfDate, rng.int(1, 28));
    const first = rng.int(0, dates.length - INSTALMENT_COUNT);
    for (let k = 1; k <= INSTALMENT_COUNT; k++) {
      const date = dates[first + k - 1];
      if (!date) throw new RangeError("parcela fora da janela");
      txns.push({
        externalId: id(date, `parcela-${pad(k, 2)}`),
        institution: "Nubank",
        account: "Cartão de crédito",
        date: formatDate(date),
        description: `Notebook - parcela ${k}/${INSTALMENT_COUNT}`,
        amountBrl: formatCents(-(each + (k === 1 ? remainder : 0))),
        kind: "debit",
        category: "compras",
      });
    }
  }

  // Aportes mensais: compra de cotas inteiras de uma ação ou FII da carteira.
  {
    const contributionBase = bps(salaryCents, CONTRIBUTION_BPS);
    const targets = [
      ...stocks.map((h, i) => ({ holding: h, priceCents: STOCKS[i]?.priceCents ?? 0 })),
      ...fiis.map((h, i) => ({ holding: h, priceCents: FIIS[i]?.priceCents ?? 0 })),
    ];
    for (const date of monthlyDates(asOfDate, rng.int(1, 28))) {
      const { holding, priceCents } = rng.pick(targets);
      const budget = jitter(rng, contributionBase, 1_000);
      const quantity = Math.max(1, Math.floor(budget / priceCents));
      txns.push({
        externalId: id(date, "aporte"),
        institution: holding.institution,
        account: "Conta investimento",
        date: formatDate(date),
        description: `Aporte mensal - compra de ${holding.code}`,
        amountBrl: formatCents(-(quantity * priceCents)),
        kind: "buy",
        category: "aporte",
        assetCode: holding.code,
        quantity: String(quantity),
      });
    }
  }

  // Ações: dividendos trimestrais e, em alguns emissores, JCP semestral.
  stocks.forEach((holding, i) => {
    const spec = STOCKS[i];
    if (!spec) throw new RangeError("índice de ação inválido");
    const annual = bps(holding.valueCents, spec.yieldBps);
    const dates = monthlyDates(asOfDate, rng.int(10, 25));
    const quarterOffset = rng.int(0, 2);
    const jcpOffset = rng.int(0, 5);
    const dividendAnnual = bps(annual, 10_000 - spec.jcpShareBps);
    dates.forEach((date, index) => {
      if (index % 3 === quarterOffset) {
        txns.push({
          externalId: id(date, `div-${holding.code}`),
          institution: holding.institution,
          account: "Conta investimento",
          date: formatDate(date),
          description: `Dividendos ${holding.code}`,
          amountBrl: formatCents(Math.max(1, jitter(rng, Math.round(dividendAnnual / 4), 1_500))),
          kind: "dividend",
          category: "proventos",
          assetCode: holding.code,
          quantity: String(holding.quantity),
        });
      }
      if (spec.jcpShareBps > 0 && index % 6 === jcpOffset) {
        const jcpAnnual = bps(annual, spec.jcpShareBps);
        txns.push({
          externalId: id(date, `jcp-${holding.code}`),
          institution: holding.institution,
          account: "Conta investimento",
          date: formatDate(date),
          description: `JCP ${holding.code}`,
          amountBrl: formatCents(Math.max(1, jitter(rng, Math.round(jcpAnnual / 2), 1_500))),
          kind: "jcp",
          category: "proventos",
          assetCode: holding.code,
          quantity: String(holding.quantity),
        });
      }
    });
  });

  // FIIs: rendimento mensal.
  fiis.forEach((holding, i) => {
    const spec = FIIS[i];
    if (!spec) throw new RangeError("índice de FII inválido");
    const monthly = bps(holding.valueCents, spec.monthlyYieldBps);
    for (const date of monthlyDates(asOfDate, rng.int(10, 20))) {
      txns.push({
        externalId: id(date, `fii-${holding.code}`),
        institution: holding.institution,
        account: "Conta investimento",
        date: formatDate(date),
        description: `Rendimento ${holding.code}`,
        amountBrl: formatCents(Math.max(1, jitter(rng, monthly, 500))),
        kind: "dividend",
        category: "rendimentos",
        assetCode: holding.code,
        quantity: String(holding.quantity),
      });
    }
  });

  // Ordem estável: data e depois externalId (comparação por code unit, sem locale).
  return txns.sort((a, b) =>
    a.date < b.date
      ? -1
      : a.date > b.date
        ? 1
        : a.externalId < b.externalId
          ? -1
          : a.externalId > b.externalId
            ? 1
            : 0,
  );
}

// ---------------------------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------------------------

/**
 * Gera a carteira sintética de um perfil: posições em `asOf` e transações dos 12 meses até `asOf`
 * (inclusive). Determinística: a mesma tripla (profile, seed, asOf) sempre devolve a mesma saída.
 * Cabe em um lote de ingestão (<= 1.000 itens por lista).
 */
export function generatePortfolio(
  profile: Profile,
  seed: number,
  asOf: string,
): SyntheticPortfolio {
  if (!Object.hasOwn(PROFILES, profile)) throw new RangeError(`perfil desconhecido: ${profile}`);
  if (!Number.isInteger(seed)) throw new RangeError(`seed precisa ser um inteiro: ${seed}`);
  const asOfDate = parseIsoDate(asOf);
  const rng = new Rng(seed);
  const { positions, stocks, fiis } = buildPositions(profile, rng, formatDate(asOfDate));
  const transactions = buildTransactions(profile, rng, asOfDate, stocks, fiis);
  return { positions, transactions };
}

/** `FinancialDataProvider` sobre o gerador: mesmo dado para qualquer `clientId`. */
export class SyntheticProvider implements FinancialDataProvider {
  readonly source = "synthetic" as const;
  private readonly portfolio: SyntheticPortfolio;

  constructor(options: { profile: Profile; seed: number; asOf: string }) {
    this.portfolio = generatePortfolio(options.profile, options.seed, options.asOf);
  }

  // O dado não depende do cliente: o parâmetro existe só para honrar a interface.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *positions(_input: { clientId: string }): AsyncGenerator<NormalizedPosition> {
    for (const p of this.portfolio.positions) yield { ...p };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *transactions(_input: { clientId: string }): AsyncGenerator<NormalizedTransaction> {
    for (const t of this.portfolio.transactions) yield { ...t };
  }
}
