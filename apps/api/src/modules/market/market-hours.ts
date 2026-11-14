const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
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
