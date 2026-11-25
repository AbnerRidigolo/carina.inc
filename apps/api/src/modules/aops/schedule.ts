import type { Schedule } from "@carina/shared";

/**
 * Agenda do AOP em America/Sao_Paulo. O Brasil não tem horário de verão desde 2019, então o
 * deslocamento é fixo em UTC-3: calculamos sobre o "relógio de parede" de São Paulo (o instante
 * deslocado -3h, lido pelos campos UTC do `Date`) e devolvemos o instante UTC real.
 */
const SP_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * O disparo agendado mais recente que é `<= now` (mesma lógica de `Schedule.previous_fire` do
 * Python, só que no fuso de São Paulo). O dia do mensal é 1..28, então existe em todo mês.
 */
export function previousFire(s: Schedule, nowMs: number): Date {
  const wall = new Date(nowMs - SP_OFFSET_MS);
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const d = wall.getUTCDate();
  const wallNow = wall.getTime();
  const anchor = Date.UTC(y, m, d, s.hour);
  let fire: number;
  if (s.frequency === "daily") {
    fire = anchor <= wallNow ? anchor : anchor - DAY_MS;
  } else if (s.frequency === "weekly") {
    // getUTCDay: 0=domingo; o contrato usa 0=segunda.
    const weekday = (wall.getUTCDay() + 6) % 7;
    const base = anchor - ((((weekday - s.weekday) % 7) + 7) % 7) * DAY_MS;
    fire = base <= wallNow ? base : base - 7 * DAY_MS;
  } else {
    const thisMonth = Date.UTC(y, m, s.day, s.hour);
    fire = thisMonth <= wallNow ? thisMonth : Date.UTC(y, m - 1, s.day, s.hour);
  }
  return new Date(fire + SP_OFFSET_MS);
}

/** `true` se há um disparo agendado ainda não executado. */
export function isDue(s: Schedule, nowMs: number, lastFireAt: Date | null): boolean {
  return lastFireAt === null || lastFireAt.getTime() < previousFire(s, nowMs).getTime();
}
