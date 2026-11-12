import {
  ExternalIdSchema,
  MoneySchema,
  PositionBatchSchema,
  QuantitySchema,
  TransactionBatchSchema,
  type NormalizedPosition,
  type NormalizedTransaction,
} from "@carina/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePortfolio, SyntheticProvider } from "./generator.js";
import { PROFILE_NAMES, PROFILES, type Profile } from "./profiles.js";

const AS_OF = "2026-11-12";
const SEEDS = [1, 2, 3, 7, 42, 99, 123, 2024, 31337, 4294967295, 0, -5];

/** "1234.50" -> 123450n (exato, sem ponto flutuante). */
function cents(money: string): bigint {
  const negative = money.startsWith("-");
  const [int = "0", frac = ""] = (negative ? money.slice(1) : money).split(".");
  const value = BigInt(int) * 100n + BigInt(frac.padEnd(2, "0"));
  return negative ? -value : value;
}

function sumCents(items: readonly { valueBrl: string }[]): bigint {
  return items.reduce((acc, p) => acc + cents(p.valueBrl), 0n);
}

/** Participação (em pontos percentuais) de cada grupo do quadro de alocação. */
function shares(positions: readonly NormalizedPosition[]) {
  const total = Number(sumCents(positions));
  const of = (...classes: string[]) =>
    (Number(sumCents(positions.filter((p) => classes.includes(p.assetClass)))) / total) * 100;
  return {
    rendaFixa: of("renda_fixa", "tesouro"),
    fundos: of("fundo"),
    fiis: of("fii"),
    acoes: of("acao"),
    caixa: of("caixa"),
  };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** asOf menos 12 meses (mesmo dia, ou fim do mês se ele não existir), como texto ISO. */
function windowStart(asOf: string): string {
  const [y = 0, m = 0, d = 0] = asOf.split("-").map(Number);
  const day = Math.min(d, daysInMonth(y - 1, m));
  return `${y - 1}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y = 0, m = 0, d = 0] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const byCategory = (txns: readonly NormalizedTransaction[], category: string) =>
  txns.filter((t) => t.category === category);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("generatePortfolio: determinismo", () => {
  it.each(PROFILE_NAMES)("mesmo seed gera saída idêntica (%s)", (profile) => {
    const a = generatePortfolio(profile, 42, AS_OF);
    const b = generatePortfolio(profile, 42, AS_OF);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.each(PROFILE_NAMES)("seeds diferentes geram saídas diferentes (%s)", (profile) => {
    const outputs = new Set(SEEDS.map((s) => JSON.stringify(generatePortfolio(profile, s, AS_OF))));
    expect(outputs.size).toBe(SEEDS.length);
  });

  it("não usa Math.random nem o relógio: só seed e asOf", () => {
    const random = vi.spyOn(Math, "random");
    vi.useFakeTimers({ now: new Date("1999-01-01T00:00:00Z") });
    const a = generatePortfolio("moderado", 5, AS_OF);
    vi.setSystemTime(new Date("2040-06-06T12:00:00Z"));
    const b = generatePortfolio("moderado", 5, AS_OF);
    expect(random).not.toHaveBeenCalled();
    expect(a).toEqual(b);
  });

  it("valor de referência fixo para um seed (trava a sequência do PRNG)", () => {
    const { positions, transactions } = generatePortfolio("moderado", 42, AS_OF);
    expect(positions.map((p) => p.valueBrl).slice(0, 3)).toMatchInlineSnapshot(`
      [
        "141641.50",
        "105892.80",
        "155427.80",
      ]
    `);
    expect(transactions.slice(0, 2).map((t) => t.externalId)).toMatchInlineSnapshot(`
      [
        "txn-2025-11-div-ITUB4",
        "txn-2025-11-alimentacao",
      ]
    `);
  });

  it("entradas inválidas são rejeitadas", () => {
    expect(() => generatePortfolio("moderado", 1.5, AS_OF)).toThrow(RangeError);
    expect(() => generatePortfolio("moderado", Number.NaN, AS_OF)).toThrow(RangeError);
    expect(() => generatePortfolio("moderado", 1, "2026-02-30")).toThrow(RangeError);
    expect(() => generatePortfolio("moderado", 1, "12/11/2026")).toThrow(RangeError);
    expect(() => generatePortfolio("outro" as Profile, 1, AS_OF)).toThrow(RangeError);
  });
});

describe("generatePortfolio: posições", () => {
  it("o moderado soma dentro de ±5% de R$ 4.000.000 (e exatamente o patrimônio)", () => {
    for (const seed of SEEDS) {
      const { positions } = generatePortfolio("moderado", seed, AS_OF);
      const total = Number(sumCents(positions)) / 100;
      expect(total).toBeGreaterThanOrEqual(4_000_000 * 0.95);
      expect(total).toBeLessThanOrEqual(4_000_000 * 1.05);
      expect(sumCents(positions)).toBe(400_000_000n);
    }
  });

  it.each(PROFILE_NAMES)("o patrimônio do %s fecha em centavos inteiros", (profile) => {
    for (const seed of SEEDS) {
      const { positions } = generatePortfolio(profile, seed, AS_OF);
      expect(sumCents(positions)).toBe(BigInt(PROFILES[profile].patrimonyCents));
    }
  });

  it("as ações do arrojado ficam entre 47% e 53%", () => {
    for (const seed of SEEDS) {
      const { positions } = generatePortfolio("arrojado", seed, AS_OF);
      expect(shares(positions).acoes).toBeGreaterThanOrEqual(47);
      expect(shares(positions).acoes).toBeLessThanOrEqual(53);
    }
  });

  it.each(PROFILE_NAMES)("cada classe do %s fica na banda ±3 p.p. do alvo", (profile) => {
    const target = PROFILES[profile].allocationPct;
    for (let seed = 0; seed < 60; seed++) {
      const s = shares(generatePortfolio(profile, seed, AS_OF).positions);
      expect(Math.abs(s.rendaFixa - target.rendaFixa)).toBeLessThanOrEqual(3);
      expect(Math.abs(s.fundos - target.fundos)).toBeLessThanOrEqual(3);
      expect(Math.abs(s.fiis - target.fiis)).toBeLessThanOrEqual(3);
      expect(Math.abs(s.acoes - target.acoes)).toBeLessThanOrEqual(3);
      expect(Math.abs(s.caixa - target.caixa)).toBeLessThanOrEqual(3);
    }
  });

  it("a alocação realmente varia com o seed (mas não sai da banda)", () => {
    const acoes = Array.from(
      { length: 30 },
      (_, seed) => shares(generatePortfolio("arrojado", seed, AS_OF).positions).acoes,
    );
    expect(Math.max(...acoes) - Math.min(...acoes)).toBeGreaterThan(1);
  });

  it("usa o universo de ativos e as instituições do brief", () => {
    const { positions } = generatePortfolio("moderado", 7, AS_OF);
    const codes = (cls: string) =>
      positions
        .filter((p) => p.assetClass === cls)
        .map((p) => p.assetCode)
        .sort();
    expect(codes("acao")).toEqual(["BBAS3", "ITUB4", "PETR4", "PRIO3", "VALE3", "WEGE3"]);
    expect(codes("fii")).toEqual(["HGLG11", "KNRI11", "MXRF11", "XPML11"]);
    const names = positions.map((p) => p.name);
    expect(names).toContain("Tesouro Selic 2029");
    expect(names).toContain("Tesouro IPCA+ 2035");
    for (const kind of ["CDB", "LCI", "LCA"]) {
      expect(names.some((n) => n.startsWith(kind))).toBe(true);
    }
    const institutions = new Set(positions.map((p) => p.institution));
    for (const i of institutions) expect(["XP", "BTG", "Itaú", "Nubank"]).toContain(i);
    expect(positions.filter((p) => p.assetClass === "caixa").every((p) => p.kind === "cash")).toBe(
      true,
    );
    expect(
      positions.filter((p) => p.assetClass !== "caixa").every((p) => p.kind === "investment"),
    ).toBe(true);
    expect(positions.every((p) => p.asOf === AS_OF)).toBe(true);
  });
});

describe("generatePortfolio: transações", () => {
  it.each(PROFILE_NAMES)("exatamente 10 parcelas de uma compra em 10x (%s)", (profile) => {
    for (const seed of SEEDS) {
      const { transactions } = generatePortfolio(profile, seed, AS_OF);
      const parcels = transactions.filter((t) => t.description.includes("parcela"));
      expect(parcels).toHaveLength(10);
      const numbers = parcels
        .map((t) => /parcela (\d+)\/10/.exec(t.description)?.[1])
        .map(Number)
        .sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(parcels.every((t) => t.kind === "debit" && cents(t.amountBrl) < 0n)).toBe(true);
    }
  });

  it("salário mensal de 1,5% do patrimônio, 12 vezes", () => {
    for (const profile of PROFILE_NAMES) {
      const { transactions } = generatePortfolio(profile, 3, AS_OF);
      const salary = byCategory(transactions, "salário");
      expect(salary).toHaveLength(12);
      const expected = (BigInt(PROFILES[profile].patrimonyCents) * 15n) / 1000n;
      for (const t of salary) {
        expect(t.kind).toBe("credit");
        expect(cents(t.amountBrl)).toBe(expected);
      }
      expect(new Set(salary.map((t) => t.date.slice(0, 7))).size).toBe(12);
    }
  });

  it("6 despesas recorrentes com as categorias do brief, 12 meses cada", () => {
    const { transactions } = generatePortfolio("moderado", 11, AS_OF);
    for (const category of ["moradia", "saúde", "educação", "alimentação", "transporte", "lazer"]) {
      const list = byCategory(transactions, category);
      expect(list, category).toHaveLength(12);
      expect(list.every((t) => t.kind === "debit" && cents(t.amountBrl) < 0n)).toBe(true);
    }
  });

  it("aportes mensais, dividendos trimestrais das ações e rendimentos mensais dos FIIs", () => {
    const { transactions } = generatePortfolio("arrojado", 8, AS_OF);
    expect(byCategory(transactions, "aporte")).toHaveLength(12);
    for (const t of byCategory(transactions, "aporte")) {
      expect(t.kind).toBe("buy");
      expect(cents(t.amountBrl)).toBeLessThan(0n);
      expect(t.assetCode).toBeDefined();
      expect(t.quantity).toBeDefined();
    }
    for (const code of ["PETR4", "VALE3", "ITUB4", "BBAS3", "WEGE3", "PRIO3"]) {
      const dividends = transactions.filter((t) => t.kind === "dividend" && t.assetCode === code);
      expect(dividends, code).toHaveLength(4);
      const months = dividends.map((t) => Number(t.date.slice(5, 7))).sort((a, b) => a - b);
      // trimestral: mesmos meses do ano, espaçados de 3 em 3 (módulo 12)
      expect(new Set(months.map((m) => m % 3)).size).toBe(1);
      expect(dividends.every((t) => cents(t.amountBrl) > 0n)).toBe(true);
    }
    for (const code of ["HGLG11", "KNRI11", "MXRF11", "XPML11"]) {
      const yields = transactions.filter((t) => t.kind === "dividend" && t.assetCode === code);
      expect(yields, code).toHaveLength(12);
      expect(new Set(yields.map((t) => t.date.slice(0, 7))).size).toBe(12);
    }
    expect(transactions.some((t) => t.kind === "jcp")).toBe(true);
  });

  it.each([
    "2026-11-12",
    "2026-01-31",
    "2026-03-31",
    "2026-03-01",
    "2025-12-31",
    "2028-02-29",
    "2024-02-29",
    "2027-02-28",
    "2026-10-30",
  ])("cobre exatamente os 12 meses até %s, sem datas futuras", (asOf) => {
    const start = windowStart(asOf);
    for (const profile of PROFILE_NAMES) {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const { transactions, positions } = generatePortfolio(profile, seed, asOf);
        expect(positions.every((p) => p.asOf === asOf)).toBe(true);
        for (const t of transactions) {
          expect(isRealIsoDate(t.date), t.date).toBe(true);
          expect(t.date <= asOf, `${t.date} <= ${asOf}`).toBe(true);
          expect(t.date >= start, `${t.date} >= ${start}`).toBe(true);
        }
        // séries mensais completas: 12 meses distintos, um por mês
        for (const category of ["salário", "moradia", "aporte"]) {
          const months = byCategory(transactions, category).map((t) => t.date.slice(0, 7));
          expect(new Set(months).size).toBe(12);
          expect(months).toHaveLength(12);
        }
        expect(transactions.filter((t) => t.description.includes("parcela"))).toHaveLength(10);
      }
    }
  });

  it("o histórico alcança o início da janela (cerca de 11 a 12 meses de dados)", () => {
    const { transactions } = generatePortfolio("moderado", 4, AS_OF);
    const dates = transactions.map((t) => t.date).sort();
    const first = dates[0] ?? "";
    expect(first >= windowStart(AS_OF)).toBe(true);
    expect(first <= "2025-12-31").toBe(true);
    expect((dates.at(-1) ?? "") >= "2026-10-12").toBe(true);
  });
});

describe("generatePortfolio: contrato de ingestão", () => {
  it.each(PROFILE_NAMES)("a saída inteira passa nos schemas de lote (%s)", (profile) => {
    for (const seed of SEEDS) {
      const { positions, transactions } = generatePortfolio(profile, seed, AS_OF);
      expect(positions.length).toBeLessThanOrEqual(1000);
      expect(transactions.length).toBeLessThanOrEqual(1000);
      expect(() => PositionBatchSchema.parse({ items: positions })).not.toThrow();
      expect(() => TransactionBatchSchema.parse({ items: transactions })).not.toThrow();
    }
  });

  it.each(PROFILE_NAMES)("dinheiro, quantidade e externalId válidos e únicos (%s)", (profile) => {
    for (const seed of SEEDS) {
      const { positions, transactions } = generatePortfolio(profile, seed, AS_OF);
      for (const p of positions) {
        expect(MoneySchema.safeParse(p.valueBrl).success, p.valueBrl).toBe(true);
        if (p.quantity !== undefined) {
          expect(QuantitySchema.safeParse(p.quantity).success, p.quantity).toBe(true);
        }
        expect(cents(p.valueBrl)).toBeGreaterThan(0n);
      }
      for (const t of transactions) {
        expect(MoneySchema.safeParse(t.amountBrl).success, t.amountBrl).toBe(true);
        if (t.quantity !== undefined) {
          expect(QuantitySchema.safeParse(t.quantity).success, t.quantity).toBe(true);
        }
        expect(cents(t.amountBrl)).not.toBe(0n);
      }
      for (const list of [positions, transactions]) {
        const ids = list.map((x) => x.externalId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
          expect(ExternalIdSchema.safeParse(id).success, id).toBe(true);
          expect(id).toMatch(/^[A-Za-z0-9._+-]{1,128}$/);
        }
      }
    }
  });

  it("dinheiro sempre com 2 casas e sem notação científica", () => {
    const { positions, transactions } = generatePortfolio("arrojado", 9, AS_OF);
    for (const m of [
      ...positions.map((p) => p.valueBrl),
      ...transactions.map((t) => t.amountBrl),
    ]) {
      expect(m).toMatch(/^-?\d+\.\d{2}$/);
    }
  });
});

describe("SyntheticProvider", () => {
  async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
  }

  it("expõe source === 'synthetic' e os mesmos dados de generatePortfolio", async () => {
    const provider = new SyntheticProvider({ profile: "conservador", seed: 77, asOf: AS_OF });
    expect(provider.source).toBe("synthetic");
    const expected = generatePortfolio("conservador", 77, AS_OF);
    expect(await collect(provider.positions({ clientId: "c1" }))).toEqual(expected.positions);
    expect(await collect(provider.transactions({ clientId: "c1" }))).toEqual(expected.transactions);
  });

  it("pode ser iterado mais de uma vez e independe do clientId", async () => {
    const provider = new SyntheticProvider({ profile: "arrojado", seed: 5, asOf: AS_OF });
    const a = await collect(provider.positions({ clientId: "a" }));
    const b = await collect(provider.positions({ clientId: "b" }));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("falha na construção com entradas inválidas", () => {
    expect(() => new SyntheticProvider({ profile: "moderado", seed: 1, asOf: "nope" })).toThrow(
      RangeError,
    );
  });
});
