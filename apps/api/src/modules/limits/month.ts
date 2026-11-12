/**
 * Meses no fuso America/Sao_Paulo, compartilhados pela cota mensal (Redis) e pelo resumo de uso
 * (billing): o mês da cota e o mês cobrado são sempre o mesmo.
 */
const TIME_ZONE = "America/Sao_Paulo";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export interface LocalTime {
  year: number;
  month: number; // 1-12
  /** Instante em que o próximo mês começa (ms epoch), no fuso de São Paulo. */
  nextMonthStartMs: number;
}

/** Deslocamento do fuso em `ms` (relógio local lido como UTC menos o instante real) e a data local. */
function zoned(ms: number): { year: number; month: number; offsetMs: number } {
  const p: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const year = p["year"] ?? 0;
  const month = p["month"] ?? 1;
  const localAsUtc = Date.UTC(
    year,
    month - 1,
    p["day"] ?? 1,
    p["hour"] ?? 0,
    p["minute"] ?? 0,
    p["second"] ?? 0,
  );
  return { year, month, offsetMs: localAsUtc - Math.floor(ms / 1000) * 1000 };
}

export function localTime(nowMs: number): LocalTime {
  const { year, month, offsetMs } = zoned(nowMs);
  // Date.UTC normaliza mês 12 → janeiro do ano seguinte.
  const nextMonthStartMs = Date.UTC(year, month, 1) - offsetMs;
  return { year, month, nextMonthStartMs };
}

/** Chave `YYYY-MM` do mês (em São Paulo) que contém o instante. */
export function monthKey(nowMs: number): string {
  const { year, month } = localTime(nowMs);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Início (inclusivo) e fim (exclusivo) do mês `YYYY-MM` em São Paulo, em ms epoch; `undefined`
 * se `month` não for um mês válido. O deslocamento é lido no próprio instante do limite (duas
 * passagens), então vale também para meses com horário de verão no passado.
 */
export function monthRange(month: string): { startMs: number; endMs: number } | undefined {
  const m = MONTH_RE.exec(month);
  if (!m) return undefined;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const startOf = (y: number, mo: number): number => {
    const wall = Date.UTC(y, mo - 1, 1); // meia-noite local lida como UTC
    let start = wall - zoned(wall).offsetMs;
    start = wall - zoned(start).offsetMs;
    return start;
  };
  return { startMs: startOf(year, mon), endMs: startOf(year, mon + 1) };
}
