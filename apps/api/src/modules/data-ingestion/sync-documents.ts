/**
 * Documentos do Sync (spec §6.4): texto determinístico, sem LLM, gerado a partir das posições e
 * transações do cliente final, com as entidades, relações e menções para o grafo.
 *
 * Módulo puro (sem banco, sem Nest, sem relógio). Regras:
 * - Dinheiro: strings decimais → centavos em BigInt → `R$ 15.000,00` (pt-BR) montado à mão; nada
 *   de `Number`, `Intl` ou locale. Percentuais em décimos de ponto percentual, arredondados meio
 *   para cima (`floor(x + 1/2)`), com aritmética inteira.
 * - Ordem: só comparações por ponto de código (`compareCodePoints`) ou por valor; nada depende de
 *   collation.
 * - Memória: os agregadores recebem as linhas em streaming (página a página) e guardam só
 *   agregados: posições por (ativo, classe, instituição); transações por mês, categoria,
 *   descrição normalizada e série de parcelas. O texto é resumido (as `TOP_POSITIONS` maiores
 *   posições, as `TOP_EXPENSE_CATEGORIES` maiores categorias etc.), então o tamanho do documento
 *   não cresce com o número de linhas.
 * - Fontes: linhas de `api`, `import` e `synthetic` entram todas; o mesmo ativo vindo de mais de
 *   uma fonte é SOMADO (não há deduplicação entre fontes), e o texto diz isso.
 * - Cada linha do texto é um parágrafo próprio (separado por linha em branco): o chunker (800
 *   caracteres) corta entre linhas, e as menções caem no chunk da linha que cita a entidade.
 */
import type { NormalizedPosition, NormalizedTransaction } from "@carina/shared";
import type { EntityInput, RelationInput } from "../knowledge/knowledge.service.js";
import { compareCodePoints, foldText } from "../knowledge/mention-match.js";

export { compareCodePoints } from "../knowledge/mention-match.js";

export const PORTFOLIO_TITLE = "Carteira consolidada";
export const CASH_FLOW_TITLE = "Fluxo de caixa 12 meses";

/**
 * Posições listadas uma a uma. 30 cobre a carteira inteira de quase todo cliente pessoa física (o
 * gerador sintético produz 20 posições por carteira) e mantém o documento em ~3 mil caracteres
 * (~5 chunks); o restante entra numa linha "Demais N posições" e nos totais por classe, que são
 * sempre completos.
 */
export const TOP_POSITIONS = 30;
export const TOP_EXPENSE_CATEGORIES = 5;
export const MAX_RECURRENCES = 15;
export const MAX_INSTALMENT_SERIES = 15;
export const MIN_RECURRENCE_MONTHS = 3;
export const WINDOW_MONTHS = 12;
/** Rótulos vindos do dado (nomes, instituições, descrições) são cortados neste tamanho. */
export const MAX_LABEL_CHARS = 120;
/**
 * Teto de chaves distintas por agregado de texto livre (descrições, categorias, séries,
 * posições). Acima dele, chaves NOVAS deixam de ser acompanhadas individualmente (os totais
 * continuam exatos); o texto avisa. Protege a memória contra dados patológicos.
 */
export const MAX_TRACKED_KEYS = 20_000;

export const SELF_REF = "cliente:self";
const SOURCES_NOTE = "todas as fontes (api, import e synthetic)";

export interface SyncDocument {
  title: string;
  text: string;
  entities: EntityInput[];
  relations: RelationInput[];
  mentions: string[];
}

// ---------------------------------------------------------------------------------------------
// Dinheiro, quantidades e percentuais
// ---------------------------------------------------------------------------------------------

const MONEY_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const QUANTITY_RE = /^(-?)(\d+)(?:\.(\d{1,8}))?$/;
const QUANTITY_SCALE = 8;

/** "1234.5" → 123450n. Só o formato do MoneySchema (sem expoente, vírgula ou espaços). */
export function parseCents(money: string): bigint {
  const m = MONEY_RE.exec(money);
  if (!m) throw new RangeError(`valor monetário inválido: ${JSON.stringify(money)}`);
  const cents = BigInt(m[2] ?? "0") * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -cents : cents;
}

/** Agrupa os dígitos de milhar com ponto. */
function groupThousands(digits: string): string {
  const head = digits.length % 3 || 3;
  const parts = [digits.slice(0, head)];
  for (let i = head; i < digits.length; i += 3) parts.push(digits.slice(i, i + 3));
  return parts.join(".");
}

/** 1500000n → "R$ 15.000,00"; -5n → "-R$ 0,05". */
export function formatBrl(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `R$ ${groupThousands((abs / 100n).toString())},${(abs % 100n).toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

function parseQuantity(q: string): bigint {
  const m = QUANTITY_RE.exec(q);
  if (!m) throw new RangeError(`quantidade inválida: ${JSON.stringify(q)}`);
  const v =
    BigInt(m[2] ?? "0") * 10n ** BigInt(QUANTITY_SCALE) +
    BigInt((m[3] ?? "").padEnd(QUANTITY_SCALE, "0"));
  return m[1] === "-" ? -v : v;
}

function formatScaledQuantity(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const unit = 10n ** BigInt(QUANTITY_SCALE);
  const int = groupThousands((abs / unit).toString());
  const frac = (abs % unit).toString().padStart(QUANTITY_SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac ? `,${frac}` : ""}`;
}

/** "1234.50000000" → "1.234,5". */
export function formatQuantity(q: string): string {
  return formatScaledQuantity(parseQuantity(q));
}

/** Divisão inteira arredondada para baixo (BigInt trunca para zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** `part/total` em décimos de ponto percentual, arredondado meio para cima. `total > 0`. */
export function percentTenths(part: bigint, total: bigint): bigint {
  if (total <= 0n) throw new RangeError("total precisa ser positivo");
  // floor(part*1000/total + 1/2) = floor((2*part*1000 + total) / (2*total))
  return floorDiv(2n * part * 1000n + total, 2n * total);
}

/** 201n → "20,1%". */
export function formatPercent(tenths: bigint): string {
  const negative = tenths < 0n;
  const abs = negative ? -tenths : tenths;
  return `${negative ? "-" : ""}${(abs / 10n).toString()},${(abs % 10n).toString()}%`;
}

// ---------------------------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------------------------

/** Rótulo vindo do dado numa linha só, sem espaços repetidos, com no máximo MAX_LABEL_CHARS. */
export function cleanLabel(s: string | undefined): string {
  if (s === undefined) return "";
  const flat = s.replace(/[\p{C}\s]+/gu, " ").trim();
  const chars = [...flat];
  return chars.length > MAX_LABEL_CHARS ? chars.slice(0, MAX_LABEL_CHARS).join("").trim() : flat;
}

/** Chave de comparação de descrições: sem acentos, minúscula, espaços simples. */
export function normalizeDescription(s: string): string {
  return foldText(cleanLabel(s)).replace(/\s+/g, " ").trim();
}

const INSTALMENT_WORD_RE = /\bparcela\s+(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})(?!\d)/iu;
const INSTALMENT_TAIL_RE = /(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})\s*$/u;

/** Rótulo da série (sem o "parcela k/n") e o índice/total; `null` se não é parcela. */
function matchInstalment(
  description: string,
): { label: string; index: number; count: number } | null {
  const text = cleanLabel(description);
  const m = INSTALMENT_WORD_RE.exec(text) ?? INSTALMENT_TAIL_RE.exec(text);
  if (!m) return null;
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 2 || index < 1 || index > count) return null;
  const label = (text.slice(0, m.index) + text.slice(m.index + m[0].length))
    .replace(/[\s\-–—:,;.]+$/u, "")
    .replace(/^[\s\-–—:,;.]+/u, "")
    .trim();
  return { label: label || "Compra parcelada", index, count };
}

/** "Notebook - parcela 3/10" → `{ base: "notebook", index: 3, count: 10 }`. */
export function parseInstalment(
  description: string,
): { base: string; index: number; count: number } | null {
  const m = matchInstalment(description);
  return m ? { base: normalizeDescription(m.label), index: m.index, count: m.count } : null;
}

const plural = (n: number | bigint, one: string, many: string) =>
  `${n.toString()} ${n === 1 || n === 1n ? one : many}`;

const ref = (type: string, name: string) => `${type}:${name}`;

/** Junta as linhas como parágrafos (o chunker corta entre parágrafos). */
const paragraphs = (lines: readonly string[]) => lines.join("\n\n");

/** Coleção de entidades sem repetição, em ordem de inserção. */
class EntitySet {
  private readonly byRef = new Map<string, EntityInput>();
  add(type: string, name: string, properties?: Record<string, unknown>): string {
    const r = ref(type, name);
    if (!this.byRef.has(r))
      this.byRef.set(r, { type, name, ...(properties ? { properties } : {}) });
    return r;
  }
  list(): EntityInput[] {
    return [...this.byRef.values()];
  }
  mentions(): string[] {
    return [...this.byRef.keys()].filter((r) => r !== SELF_REF);
  }
}

// ---------------------------------------------------------------------------------------------
// Carteira consolidada
// ---------------------------------------------------------------------------------------------

const CLASS_LABEL: Record<NormalizedPosition["assetClass"], string> = {
  acao: "ação",
  fii: "FII",
  tesouro: "tesouro",
  renda_fixa: "renda fixa",
  fundo: "fundo",
  caixa: "caixa",
};

interface Holding {
  asset: string; // código ou nome (rótulo limpo); "" se o dado não tem nenhum
  name: string;
  assetClass: NormalizedPosition["assetClass"];
  institution: string;
  valueCents: bigint;
  /** Soma das quantidades (escala 1e-8); `null` se alguma linha somada não tinha quantidade. */
  quantity: bigint | null;
}

export class PortfolioAggregator {
  private readonly holdings = new Map<string, Holding>();
  private readonly byClass = new Map<string, bigint>();
  private totalCents = 0n;
  private rows = 0;
  private overflowCents = 0n;
  private overflowRows = 0;

  add(p: NormalizedPosition): void {
    const value = parseCents(p.valueBrl);
    this.rows++;
    this.totalCents += value;
    this.byClass.set(p.assetClass, (this.byClass.get(p.assetClass) ?? 0n) + value);

    const asset = cleanLabel(p.assetCode) || cleanLabel(p.name);
    const institution = cleanLabel(p.institution);
    const key = `${asset}\u0000${p.assetClass}\u0000${institution}`;
    const quantity = p.quantity === undefined ? null : parseQuantity(p.quantity);
    const prev = this.holdings.get(key);
    if (prev) {
      prev.valueCents += value;
      prev.quantity = prev.quantity === null || quantity === null ? null : prev.quantity + quantity;
      return;
    }
    if (this.holdings.size >= MAX_TRACKED_KEYS) {
      this.overflowCents += value;
      this.overflowRows++;
      return;
    }
    this.holdings.set(key, {
      asset,
      name: cleanLabel(p.name),
      assetClass: p.assetClass,
      institution,
      valueCents: value,
      quantity,
    });
  }

  build(): SyncDocument | null {
    if (this.rows === 0) return null;
    const sorted = [...this.holdings.values()].sort(
      (a, b) =>
        (a.valueCents === b.valueCents ? 0 : a.valueCents > b.valueCents ? -1 : 1) ||
        compareCodePoints(a.asset, b.asset) ||
        compareCodePoints(a.assetClass, b.assetClass) ||
        compareCodePoints(a.institution, b.institution),
    );
    const top = sorted.slice(0, TOP_POSITIONS);
    const rest = sorted.slice(TOP_POSITIONS);
    const entities = new EntitySet();
    entities.add("cliente", "self");
    const relations: RelationInput[] = [];

    const lines: string[] = [
      `${PORTFOLIO_TITLE}: ${plural(this.rows, "posição", "posições")} de ${SOURCES_NOTE}, ` +
        `patrimônio total ${formatBrl(this.totalCents)}. Posições do mesmo ativo na mesma ` +
        `instituição e classe são somadas, inclusive entre fontes diferentes.`,
      top.length === sorted.length && this.overflowRows === 0
        ? `Posições por valor (${plural(top.length, "linha", "linhas")}):`
        : `As ${top.length.toString()} maiores posições por valor:`,
    ];
    for (const h of top) {
      const qty = h.quantity === null ? "" : `${formatScaledQuantity(h.quantity)} `;
      const asset = h.asset || "Ativo sem nome";
      const inst = h.institution || "instituição não informada";
      lines.push(
        `${qty}${asset} (${CLASS_LABEL[h.assetClass]}) na ${inst}: ${formatBrl(h.valueCents)}`,
      );
      if (!h.asset) continue;
      const assetRef = entities.add(
        "ativo",
        h.asset,
        h.name && h.name !== h.asset ? { nome: h.name } : undefined,
      );
      const classRef = entities.add("classe", h.assetClass);
      relations.push({ sourceRef: SELF_REF, targetRef: assetRef, type: "POSSUI" });
      relations.push({ sourceRef: assetRef, targetRef: classRef, type: "DA_CLASSE" });
      if (h.institution) {
        const instRef = entities.add("instituicao", h.institution);
        relations.push({ sourceRef: assetRef, targetRef: instRef, type: "CUSTODIADO_EM" });
      }
    }
    const restCount = rest.length + this.overflowRows;
    if (restCount > 0) {
      const restCents = rest.reduce((s, h) => s + h.valueCents, 0n) + this.overflowCents;
      lines.push(`Demais ${plural(restCount, "posição", "posições")}: ${formatBrl(restCents)}.`);
    }

    lines.push("Alocação por classe:");
    const classes = [...this.byClass.entries()].sort(
      ([ca, a], [cb, b]) => (a === b ? 0 : a > b ? -1 : 1) || compareCodePoints(ca, cb),
    );
    for (const [assetClass, cents] of classes) {
      const label = CLASS_LABEL[assetClass as NormalizedPosition["assetClass"]] ?? assetClass;
      const pct =
        this.totalCents > 0n
          ? `${formatPercent(percentTenths(cents, this.totalCents))} do patrimônio`
          : "percentual indisponível (patrimônio não positivo)";
      lines.push(`Classe ${assetClass} (${label}): ${pct}, ${formatBrl(cents)}.`);
      entities.add("classe", assetClass);
    }

    return {
      title: PORTFOLIO_TITLE,
      text: paragraphs(lines),
      entities: entities.list(),
      relations,
      mentions: entities.mentions(),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Fluxo de caixa 12 meses
// ---------------------------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Índice de mês absoluto (ano*12 + mês-1) de `YYYY-MM-DD` ou `YYYY-MM`. */
function monthIndex(date: string): number {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m) throw new RangeError(`data inválida: ${date}`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

const monthLabel = (index: number) =>
  `${String(Math.floor(index / 12)).padStart(4, "0")}-${pad2((index % 12) + 1)}`;

/**
 * Os `WINDOW_MONTHS` meses civis que terminam no mês de `newestDate` (a transação mais recente:
 * nada depende do relógio, então dois Syncs dos mesmos dados geram o mesmo texto) e o 1º dia.
 */
export function cashFlowWindow(newestDate: string): { from: string; months: string[] } {
  const end = monthIndex(newestDate);
  const months = Array.from({ length: WINDOW_MONTHS }, (_, i) =>
    monthLabel(end - WINDOW_MONTHS + 1 + i),
  );
  return { from: `${months[0] ?? monthLabel(end)}-01`, months };
}

const EXPENSE_KINDS: ReadonlySet<NormalizedTransaction["kind"]> = new Set(["debit", "fee", "tax"]);
const NO_CATEGORY = "sem categoria";

interface MonthTotals {
  inflow: bigint;
  outflow: bigint; // valor absoluto
}

interface CategoryTotals {
  cents: bigint; // valor absoluto das despesas
  count: number;
}

interface DescriptionTotals {
  display: string;
  category: string;
  months: number; // bitmask dos meses da janela
  count: number;
  cents: bigint; // com sinal
}

interface InstalmentSeries {
  display: string;
  count: number; // total de parcelas da série (n de k/n)
  seen: Set<number>;
  cents: bigint; // com sinal
}

const bitCount = (mask: number) => {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
};

export class CashFlowAggregator {
  readonly from: string;
  private readonly start: number;
  private readonly months: MonthTotals[];
  private readonly categories = new Map<string, CategoryTotals>();
  private readonly descriptions = new Map<string, DescriptionTotals>();
  private readonly series = new Map<string, InstalmentSeries>();
  private rows = 0;
  private truncated = false;

  constructor(newestDate: string) {
    const window = cashFlowWindow(newestDate);
    this.from = window.from;
    this.start = monthIndex(window.from);
    this.months = Array.from({ length: WINDOW_MONTHS }, () => ({ inflow: 0n, outflow: 0n }));
  }

  /** Transações fora da janela são ignoradas. */
  add(t: NormalizedTransaction): void {
    const slot = monthIndex(t.date) - this.start;
    const month = this.months[slot];
    if (!month) return;
    this.rows++;
    const cents = parseCents(t.amountBrl);
    if (cents > 0n) month.inflow += cents;
    else month.outflow -= cents;

    const category = cleanLabel(t.category) || NO_CATEGORY;
    if (cents < 0n && EXPENSE_KINDS.has(t.kind)) {
      const cat = this.track(this.categories, category, () => ({ cents: 0n, count: 0 }));
      if (cat) {
        cat.cents -= cents;
        cat.count++;
      }
    }

    const instalment = matchInstalment(t.description);
    if (instalment) {
      const key = `${normalizeDescription(instalment.label)}\u0000${instalment.count.toString()}`;
      const s = this.track(this.series, key, () => ({
        display: instalment.label,
        count: instalment.count,
        seen: new Set<number>(),
        cents: 0n,
      }));
      if (s) {
        s.seen.add(instalment.index);
        s.cents += cents;
      }
      return;
    }

    const key = normalizeDescription(t.description);
    if (!key) return;
    const d = this.track(this.descriptions, key, () => ({
      display: cleanLabel(t.description),
      category,
      months: 0,
      count: 0,
      cents: 0n,
    }));
    if (d) {
      d.months |= 1 << slot;
      d.count++;
      d.cents += cents;
    }
  }

  private track<V>(map: Map<string, V>, key: string, init: () => V): V | undefined {
    const found = map.get(key);
    if (found) return found;
    if (map.size >= MAX_TRACKED_KEYS) {
      this.truncated = true;
      return undefined;
    }
    const v = init();
    map.set(key, v);
    return v;
  }

  build(): SyncDocument | null {
    if (this.rows === 0) return null;
    const entities = new EntitySet();
    entities.add("cliente", "self");
    const relations: RelationInput[] = [];
    const first = monthLabel(this.start);
    const last = monthLabel(this.start + WINDOW_MONTHS - 1);
    const inflow = this.months.reduce((s, m) => s + m.inflow, 0n);
    const outflow = this.months.reduce((s, m) => s + m.outflow, 0n);

    const lines: string[] = [
      `${CASH_FLOW_TITLE}: de ${first} a ${last}, ${plural(this.rows, "lançamento", "lançamentos")} ` +
        `de ${SOURCES_NOTE}. Entradas são os valores positivos e saídas os negativos ` +
        `(inclusive compras de ativos).`,
      `Entradas: ${formatBrl(inflow)}. Saídas: ${formatBrl(outflow)}. Saldo: ${formatBrl(inflow - outflow)}.`,
    ];
    this.months.forEach((m, i) => {
      lines.push(
        `Mês ${monthLabel(this.start + i)}: entradas ${formatBrl(m.inflow)}, saídas ` +
          `${formatBrl(m.outflow)}, saldo ${formatBrl(m.inflow - m.outflow)}.`,
      );
    });

    const byCents = <T extends { cents: bigint }>(a: T, b: T) => {
      const x = a.cents < 0n ? -a.cents : a.cents;
      const y = b.cents < 0n ? -b.cents : b.cents;
      return x === y ? 0 : x > y ? -1 : 1;
    };

    const categories = [...this.categories.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => byCents(a, b) || compareCodePoints(a.name, b.name))
      .slice(0, TOP_EXPENSE_CATEGORIES);
    if (categories.length > 0) {
      lines.push(
        `Top ${categories.length.toString()} categorias de despesa (débitos, tarifas e impostos):`,
      );
      categories.forEach((c, i) => {
        lines.push(
          `${(i + 1).toString()}. Categoria ${c.name}: ${formatBrl(c.cents)} em ` +
            `${plural(c.count, "lançamento", "lançamentos")}.`,
        );
        if (c.name !== NO_CATEGORY) {
          const catRef = entities.add("categoria", c.name);
          relations.push({ sourceRef: SELF_REF, targetRef: catRef, type: "DESPESA_EM" });
        }
      });
    }

    const recurrences = [...this.descriptions.entries()]
      .map(([key, v]) => ({ key, ...v, monthCount: bitCount(v.months) }))
      .filter((d) => d.monthCount >= MIN_RECURRENCE_MONTHS)
      .sort(
        (a, b) => b.monthCount - a.monthCount || byCents(a, b) || compareCodePoints(a.key, b.key),
      );
    if (recurrences.length > 0) {
      lines.push(
        `Recorrências (mesma descrição em ${MIN_RECURRENCE_MONTHS.toString()} meses ou mais):`,
      );
      for (const r of recurrences.slice(0, MAX_RECURRENCES)) {
        lines.push(
          `Recorrência "${r.display}": ${plural(r.monthCount, "mês", "meses")}, ` +
            `${plural(r.count, "lançamento", "lançamentos")}, total ${formatBrl(r.cents)}, ` +
            `categoria ${r.category}.`,
        );
        if (r.category !== NO_CATEGORY) entities.add("categoria", r.category);
      }
      if (recurrences.length > MAX_RECURRENCES) {
        lines.push(
          `E mais ${plural(recurrences.length - MAX_RECURRENCES, "recorrência", "recorrências")}.`,
        );
      }
    }

    const series = [...this.series.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => byCents(a, b) || compareCodePoints(a.key, b.key));
    if (series.length > 0) {
      lines.push("Parcelamentos:");
      for (const s of series.slice(0, MAX_INSTALMENT_SERIES)) {
        const seen = [...s.seen].sort((a, b) => a - b);
        lines.push(
          `Parcelamento "${s.display}" em ${s.count.toString()}x: ` +
            `${plural(seen.length, "parcela", "parcelas")} no período ` +
            `(${(seen[0] ?? 0).toString()} a ${(seen.at(-1) ?? 0).toString()}), total ${formatBrl(s.cents)}.`,
        );
      }
      if (series.length > MAX_INSTALMENT_SERIES) {
        lines.push(
          `E mais ${plural(series.length - MAX_INSTALMENT_SERIES, "parcelamento", "parcelamentos")}.`,
        );
      }
    }

    if (this.truncated) {
      lines.push(
        "Aviso: descrições e categorias distintas demais; só as primeiras foram acompanhadas uma a uma (os totais mensais estão completos).",
      );
    }

    return {
      title: CASH_FLOW_TITLE,
      text: paragraphs(lines),
      entities: entities.list(),
      relations,
      mentions: entities.mentions(),
    };
  }
}
