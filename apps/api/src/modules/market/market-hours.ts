const SAO_PAULO = "America/Sao_Paulo";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SAO_PAULO,
  weekday: "short",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

const OPEN_MINUTE = 10 * 60;
const CLOSE_MINUTE = 18 * 60;

/** Pregão da B3 (sem feriados): segunda a sexta, de 10:00 (inclusive) a 18:00 (exclusive), em SP. */
export function marketStateAt(ms: number): "open" | "closed" {
  const parts = formatter.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  return minute >= OPEN_MINUTE && minute < CLOSE_MINUTE ? "open" : "closed";
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SAO_PAULO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Data de São Paulo (`YYYY-MM-DD`) no instante `ms`: o dia de pregão do monitor de carteira. */
export function saoPauloDate(ms: number): string {
  const parts = dateFormatter.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
