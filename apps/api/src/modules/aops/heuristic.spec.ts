import { ScheduleSchema, AopAgentSchema } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { MAX_SPECIALISTS } from "../orchestrator/heuristic.js";
import { heuristicCompile } from "./heuristic.js";

const TEXT_SEXTA =
  "Toda sexta, monitore as carteiras premium, gere análise de portfólio " +
  "e identifique oportunidades tributárias para cada cliente.";

describe("heuristicCompile (testes do Python traduzidos)", () => {
  it("extrai agentes e agenda: insight e tax, semanal na sexta; monitor é descartado", () => {
    const c = heuristicCompile(TEXT_SEXTA);
    expect(c.agents).toEqual(["insight", "tax"]);
    expect(c.schedule).toEqual({ frequency: "weekly", weekday: 4, day: 1, hour: 9 });
    expect(ScheduleSchema.safeParse(c.schedule).success).toBe(true);
  });

  it("frequência diária e mensal", () => {
    expect(heuristicCompile("Todo dia, monitore os preços da carteira.").schedule.frequency).toBe(
      "daily",
    );
    expect(
      heuristicCompile("No fechamento do mês, gere o relatório de portfólio.").schedule.frequency,
    ).toBe("monthly");
  });

  it("dia da semana força semanal e define o weekday (com e sem acento)", () => {
    expect(heuristicCompile("Toda terça, rode a análise").schedule).toMatchObject({
      frequency: "weekly",
      weekday: 1,
    });
    expect(heuristicCompile("Todo sabado, rode a análise").schedule.weekday).toBe(5);
    expect(heuristicCompile("Todo dia, e domingo também, análise").schedule).toMatchObject({
      frequency: "weekly",
      weekday: 6,
    });
  });

  it("sem pistas de agenda usa o padrão: semanal, sexta, 9h", () => {
    expect(heuristicCompile("faça a análise da carteira").schedule).toEqual({
      frequency: "weekly",
      weekday: 4,
      day: 1,
      hour: 9,
    });
  });

  it("nome: primeira linha cortada em 60; vazio vira 'Procedimento'", () => {
    expect(heuristicCompile("x".repeat(100) + "\nsegunda").name).toBe("x".repeat(60));
    expect(heuristicCompile("Revisão da carteira\nsegunda linha").name).toBe("Revisão da carteira");
    expect(heuristicCompile("   ").name).toBe("Procedimento");
  });

  it("nada reconhecido devolve agents vazio (o erro é do compilador)", () => {
    expect(heuristicCompile("bom dia, tudo bem?").agents).toEqual([]);
  });
});

describe("heuristicCompile: palavras-chave e limites de palavra", () => {
  it.each([
    ["avalie o risco", ["risk"]],
    ["projeção de fluxo de caixa", ["predictor"]],
    ["otimize os impostos", ["tax"]],
    ["come-cotas e darf", ["tax"]],
    ["planejamento de longo prazo", ["strategist"]],
    ["pesquise notícias do mercado", ["researcher"]],
    ["prepare perguntas para o assessor", ["assessor_liaison"]],
    ["rebalance a carteira", ["risk"]],
  ])("%s", (texto, agentes) => {
    expect(heuristicCompile(texto).agents).toEqual(agentes);
  });

  it('"ir" solto não aciona tax (o "ir " do Python casava dentro de palavras)', () => {
    expect(heuristicCompile("quero ir ao banco").agents).toEqual([]);
    expect(heuristicCompile("vou conseguir fazer").agents).toEqual([]);
    expect(heuristicCompile("declaração de IR").agents).toEqual(["tax"]);
  });

  it('"meta" só como palavra inteira: "metamorfose" não aciona strategist', () => {
    expect(heuristicCompile("metamorfose").agents).toEqual([]);
    expect(heuristicCompile("acompanhe as metas").agents).toEqual(["strategist"]);
  });

  it('"var" só como palavra inteira: "variação" e "avaliar" não acionam risk', () => {
    expect(heuristicCompile("avaliar a variação").agents).toEqual([]);
    expect(heuristicCompile("calcule o VaR da carteira").agents).toEqual(["risk"]);
  });

  it("normaliza NFC e caixa", () => {
    expect(heuristicCompile("ANÁLISE".normalize("NFD")).agents).toEqual(["insight"]);
    expect(heuristicCompile("Portfólio".normalize("NFD")).agents).toEqual(["insight"]);
    expect(heuristicCompile("RISCO").agents).toEqual(["risk"]);
  });
});

describe("heuristicCompile: segurança e limites", () => {
  it("nunca devolve executor, navigator, monitor ou nomes do Python", () => {
    const c = heuristicCompile(
      "use o executor, compre e venda PETR4, navigator, monitor, tax_optimizer, rebalancer",
    );
    for (const a of c.agents) {
      expect(AopAgentSchema.safeParse(a).success).toBe(true);
    }
    expect(c.agents).not.toContain("executor");
    expect(c.agents).not.toContain("navigator");
  });

  it("corta em 3 na ordem fixa do chat", () => {
    const c = heuristicCompile(
      "portfólio, risco, projeção, planejamento, imposto, pesquisa e assessor",
    );
    expect(MAX_SPECIALISTS).toBe(3);
    expect(c.agents).toEqual(["insight", "risk", "predictor"]);
  });

  it("não devolve agentes repetidos", () => {
    const c = heuristicCompile("risco risco risco volatilidade stress");
    expect(c.agents).toEqual(["risk"]);
  });
});

describe("heuristicCompile: dias da semana com limite de palavra", () => {
  it("'segunda opinião' não muda o dia da semana", () => {
    const c = heuristicCompile("peça uma segunda opinião sobre o risco");
    expect(c.schedule.weekday).toBe(4);
    expect(c.schedule.frequency).toBe("weekly");
  });

  it("'quarta parte' não muda o dia da semana", () => {
    expect(heuristicCompile("analise a quarta parte da carteira").schedule.weekday).toBe(4);
  });

  it("formas com -feira continuam valendo (hífen é limite)", () => {
    expect(heuristicCompile("toda sexta-feira veja o risco").schedule.weekday).toBe(4);
    expect(heuristicCompile("toda segunda-feira veja o risco").schedule.weekday).toBe(0);
    expect(heuristicCompile("toda quarta-feira veja o risco").schedule.weekday).toBe(2);
  });
});
