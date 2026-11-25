import { type Schedule } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { isDue, previousFire } from "./schedule.js";

/** Horário de Brasília (UTC-3, sem horário de verão) como instante UTC. */
const sp = (iso: string): Date => new Date(`${iso}:00-03:00`);
const s = (frequency: Schedule["frequency"], extra: Partial<Schedule> = {}): Schedule => ({
  frequency,
  weekday: 4,
  day: 1,
  hour: 9,
  ...extra,
});

describe("isDue (testes do Python traduzidos, em São Paulo)", () => {
  it("diária: vence sem execução anterior e conforme a última execução", () => {
    const sched = s("daily", { hour: 8 });
    const now = sp("2026-06-11T08:30").getTime();
    expect(isDue(sched, now, null)).toBe(true);
    expect(isDue(sched, now, sp("2026-06-11T08:30"))).toBe(false);
    expect(isDue(sched, now, sp("2026-06-10T08:30"))).toBe(true);
  });

  it("semanal: previousFire é a sexta 09h e isDue respeita a última execução", () => {
    const sched = s("weekly");
    const now = sp("2026-06-10T10:00").getTime(); // quarta
    expect(previousFire(sched, now)).toEqual(sp("2026-06-05T09:00"));
    expect(isDue(sched, now, sp("2026-06-04T09:00"))).toBe(true);
    expect(isDue(sched, now, sp("2026-06-05T12:00"))).toBe(false);
  });

  it("mensal: previousFire é o dia 1 às 09h; antes dele volta ao mês anterior", () => {
    const sched = s("monthly");
    const now = sp("2026-06-10T10:00").getTime();
    expect(previousFire(sched, now)).toEqual(sp("2026-06-01T09:00"));
    expect(isDue(sched, now, sp("2026-05-30T00:00"))).toBe(true);
    expect(isDue(sched, now, sp("2026-06-01T12:00"))).toBe(false);
    const early = sp("2026-06-01T08:00").getTime();
    expect(previousFire(sched, early)).toEqual(sp("2026-05-01T09:00"));
  });

  it("isDue é falso quando a última execução é exatamente o disparo", () => {
    const sched = s("weekly");
    const now = sp("2026-06-10T10:00").getTime();
    expect(isDue(sched, now, sp("2026-06-05T09:00"))).toBe(false);
    expect(isDue(sched, now, new Date(sp("2026-06-05T09:00").getTime() - 1))).toBe(true);
  });
});

/**
 * Tabela de paridade gerada rodando o Python (`Schedule.previous_fire`, `python3 -I`): a hora de
 * São Paulo vira UTC somando 3h para o Python e o resultado volta subtraindo 3h. Colunas:
 * frequência, weekday, day, hora (SP), agora (SP), disparo esperado (SP).
 */
const PARIDADE_PYTHON: readonly (readonly [
  Schedule["frequency"],
  number,
  number,
  number,
  string,
  string,
])[] = [
  ["daily", 4, 1, 9, "2026-06-10T09:00", "2026-06-10T09:00"],
  ["daily", 4, 1, 9, "2026-06-10T08:59", "2026-06-09T09:00"],
  ["daily", 4, 1, 9, "2026-06-10T23:59", "2026-06-10T09:00"],
  ["daily", 4, 1, 0, "2026-06-10T00:00", "2026-06-10T00:00"],
  ["daily", 4, 1, 0, "2026-06-10T23:30", "2026-06-10T00:00"],
  ["daily", 4, 1, 20, "2026-06-10T00:30", "2026-06-09T20:00"],
  ["daily", 4, 1, 20, "2026-03-01T19:59", "2026-02-28T20:00"],
  ["weekly", 4, 1, 9, "2026-06-05T09:00", "2026-06-05T09:00"],
  ["weekly", 4, 1, 9, "2026-06-05T08:59", "2026-05-29T09:00"],
  ["weekly", 4, 1, 9, "2026-06-08T00:00", "2026-06-05T09:00"],
  ["weekly", 4, 1, 9, "2026-06-11T12:00", "2026-06-05T09:00"],
  ["weekly", 0, 1, 0, "2026-06-08T00:00", "2026-06-08T00:00"],
  ["weekly", 0, 1, 0, "2026-06-07T23:59", "2026-06-01T00:00"],
  ["weekly", 6, 1, 20, "2026-06-07T20:00", "2026-06-07T20:00"],
  ["weekly", 6, 1, 20, "2026-06-07T19:59", "2026-05-31T20:00"],
  ["weekly", 4, 1, 9, "2026-03-02T10:00", "2026-02-27T09:00"],
  ["weekly", 2, 1, 9, "2026-01-01T08:00", "2025-12-31T09:00"],
  ["monthly", 4, 1, 9, "2026-06-01T09:00", "2026-06-01T09:00"],
  ["monthly", 4, 1, 9, "2026-06-01T08:59", "2026-05-01T09:00"],
  ["monthly", 4, 1, 9, "2026-06-15T12:00", "2026-06-01T09:00"],
  ["monthly", 4, 28, 9, "2026-06-28T09:00", "2026-06-28T09:00"],
  ["monthly", 4, 28, 9, "2026-06-28T08:59", "2026-05-28T09:00"],
  ["monthly", 4, 28, 9, "2026-06-30T23:59", "2026-06-28T09:00"],
  ["monthly", 4, 28, 9, "2026-03-01T00:00", "2026-02-28T09:00"],
  ["monthly", 4, 28, 9, "2026-03-28T08:59", "2026-02-28T09:00"],
  ["monthly", 4, 28, 0, "2026-03-28T00:00", "2026-03-28T00:00"],
  ["monthly", 4, 28, 0, "2026-03-27T23:59", "2026-02-28T00:00"],
  ["monthly", 4, 28, 9, "2026-02-28T09:00", "2026-02-28T09:00"],
  ["monthly", 4, 28, 9, "2028-03-10T00:00", "2028-02-28T09:00"],
  ["monthly", 4, 1, 0, "2026-01-01T00:00", "2026-01-01T00:00"],
  ["monthly", 4, 15, 9, "2026-01-10T00:00", "2025-12-15T09:00"],
  ["monthly", 4, 28, 20, "2026-12-31T23:59", "2026-12-28T20:00"],
];

describe("previousFire: paridade com o Python", () => {
  it.each(PARIDADE_PYTHON)(
    "%s wd=%i d=%i h=%i agora %s -> %s",
    (frequency, weekday, day, hour, now, esperado) => {
      const got = previousFire({ frequency, weekday, day, hour }, sp(now).getTime());
      expect(got).toEqual(sp(esperado));
    },
  );
});

describe("previousFire: perto da meia-noite e no fim do mês (Review Focus 3)", () => {
  it("23h de São Paulo já é o dia seguinte em UTC: o disparo continua no dia de São Paulo", () => {
    const now = sp("2026-06-10T23:30").getTime(); // 02:30 UTC de 11/06
    expect(previousFire(s("daily", { hour: 23 }), now)).toEqual(sp("2026-06-10T23:00"));
    expect(previousFire(s("daily", { hour: 23 }), sp("2026-06-10T22:59").getTime())).toEqual(
      sp("2026-06-09T23:00"),
    );
  });

  it("21h-23h SP (já no dia seguinte em UTC) em semanal e mensal", () => {
    // 2026-06-05 é sexta; 23:00 SP = 02:00 UTC de sábado.
    expect(previousFire(s("weekly", { hour: 23 }), sp("2026-06-05T23:00").getTime())).toEqual(
      sp("2026-06-05T23:00"),
    );
    expect(previousFire(s("weekly", { hour: 23 }), sp("2026-06-05T22:59").getTime())).toEqual(
      sp("2026-05-29T23:00"),
    );
    expect(
      previousFire(s("monthly", { day: 28, hour: 22 }), sp("2026-03-28T21:59").getTime()),
    ).toEqual(sp("2026-02-28T22:00"));
  });

  it("00:30 UTC ainda é o dia anterior em São Paulo (21:30)", () => {
    const now = new Date("2026-06-11T00:30:00Z").getTime();
    expect(previousFire(s("daily", { hour: 21 }), now)).toEqual(sp("2026-06-10T21:00"));
    expect(previousFire(s("daily", { hour: 22 }), now)).toEqual(sp("2026-06-09T22:00"));
  });

  it("dia 28 em fevereiro de ano bissexto (29 dias) e virada de ano", () => {
    const sched = s("monthly", { day: 28 });
    expect(previousFire(sched, sp("2028-02-29T12:00").getTime())).toEqual(sp("2028-02-28T09:00"));
    expect(previousFire(sched, sp("2028-03-01T00:00").getTime())).toEqual(sp("2028-02-28T09:00"));
    expect(previousFire(s("monthly"), sp("2026-01-01T08:59").getTime())).toEqual(
      sp("2025-12-01T09:00"),
    );
  });

  it("varrendo 40 dias de 15 em 15 min: o disparo é monotônico, no máximo 24h atrás e muda uma vez por dia", () => {
    const sched = s("daily", { hour: 23 });
    const fires = new Set<number>();
    const start = sp("2026-02-20T00:00").getTime();
    let last = 0;
    for (let t = start; t < start + 40 * 86_400_000; t += 15 * 60_000) {
      const f = previousFire(sched, t).getTime();
      expect(f).toBeLessThanOrEqual(t);
      expect(f).toBeGreaterThan(t - 86_400_000);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
      fires.add(f);
    }
    expect(fires.size).toBe(41);
  });

  it("isDue com disparo às 23h: executou às 23:05, não vence de novo até o dia seguinte", () => {
    const sched = s("daily", { hour: 23 });
    const ran = sp("2026-06-10T23:05");
    expect(isDue(sched, sp("2026-06-11T08:00").getTime(), ran)).toBe(false);
    expect(isDue(sched, sp("2026-06-11T23:00").getTime(), ran)).toBe(true);
  });
});
