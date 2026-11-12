import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { PlanSchema } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { QUESTION_MESSAGE_ID } from "../agents/agent.js";
import {
  MAX_RATIONALE_CHARS,
  classifierMockResponder,
  heuristicPlan,
  normalizePlan,
  wantsExecution,
} from "./heuristic.js";

describe("heuristicPlan", () => {
  it('"olá" → simples, sem agentes nem execução', () => {
    const plan = heuristicPlan("olá");
    expect(plan).toMatchObject({ complexity: "simples", agents: [], wantsExecution: false });
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  it('"qual o risco da minha carteira?" → complexa, insight + risk', () => {
    const plan = heuristicPlan("qual o risco da minha carteira?");
    expect(plan.complexity).toBe("complexa");
    expect(plan.agents).toEqual(["insight", "risk"]);
    expect(plan.wantsExecution).toBe(false);
  });

  it('"compre 100 PETR4" → média, wantsExecution, sem especialistas', () => {
    const plan = heuristicPlan("compre 100 PETR4");
    expect(plan).toMatchObject({ complexity: "média", agents: [], wantsExecution: true });
  });

  it("projeção + risco + carteira → os três especialistas, ordem fixa", () => {
    expect(heuristicPlan("projeção e risco da carteira").agents).toEqual([
      "insight",
      "risk",
      "predictor",
    ]);
  });

  it("um especialista → média; caixa e acentos maiúsculos não atrapalham", () => {
    expect(heuristicPlan("PREVISÃO do FLUXO DE CAIXA")).toMatchObject({
      complexity: "média",
      agents: ["predictor"],
    });
  });

  it("acentos decompostos (NFD) casam como os compostos (NFC)", () => {
    const nfd = "previsão e composição".normalize("NFD");
    expect(nfd).not.toBe("previsão e composição");
    expect(heuristicPlan(nfd).agents).toEqual(["insight", "predictor"]);
  });

  it("verbos de execução: só no começo de palavra", () => {
    for (const q of ["venda tudo", "transfira 10 mil", "resgate o CDB", "rebalanceie já"]) {
      expect(wantsExecution(q)).toBe(true);
    }
    expect(wantsExecution("descompressão")).toBe(false);
    expect(wantsExecution("olá")).toBe(false);
  });

  it("entrada não-string ou gigante não quebra", () => {
    expect(heuristicPlan(undefined as unknown as string).complexity).toBe("simples");
    expect(heuristicPlan(`${"x".repeat(100_000)} risco`).agents).toEqual([]);
  });
});

describe("normalizePlan (saída do modelo é não confiável)", () => {
  it("rejeita o que não bate com o PlanSchema", () => {
    expect(normalizePlan({ complexity: "simples", agents: ["hacker"] }, "oi")).toBeUndefined();
    expect(normalizePlan("texto", "oi")).toBeUndefined();
  });

  it("deduplica agentes, recalcula a complexidade e corta o motivo", () => {
    const plan = normalizePlan(
      {
        complexity: "simples",
        agents: ["risk", "risk", "insight"],
        wantsExecution: false,
        rationale: "r".repeat(5000),
      },
      "qual o risco?",
    );
    expect(plan?.agents).toEqual(["risk", "insight"]);
    expect(plan?.complexity).toBe("complexa");
    expect(plan?.rationale.length).toBe(MAX_RATIONALE_CHARS);
  });

  it("o modelo não liga execução sozinho: precisa do verbo de execução na pergunta", () => {
    const raw = { complexity: "média", agents: [], wantsExecution: true, rationale: "x" };
    expect(normalizePlan(raw, "como está minha carteira?")?.wantsExecution).toBe(false);
    expect(normalizePlan(raw, "compre 10 VALE3")?.wantsExecution).toBe(true);
    expect(
      normalizePlan({ ...raw, wantsExecution: false }, "compre 10 VALE3")?.wantsExecution,
    ).toBe(false);
  });
});

describe("classifierMockResponder", () => {
  it("aplica a heurística à pergunta (mensagem com o id da pergunta)", () => {
    const out = classifierMockResponder({
      mockKey: "classifier",
      messages: [
        new SystemMessage("x"),
        new HumanMessage({ content: "qual o risco da minha carteira?", id: QUESTION_MESSAGE_ID }),
      ],
    });
    expect(out).toEqual(heuristicPlan("qual o risco da minha carteira?"));
  });
});
