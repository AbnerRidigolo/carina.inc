import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { PlanSchema } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { QUESTION_MESSAGE_ID } from "../agents/agent.js";
import {
  CLASSIFIER_PROMPT,
  MAX_RATIONALE_CHARS,
  MAX_SPECIALISTS,
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

  it("imposto/IR/DARF → tax", () => {
    for (const q of ["quanto de imposto pago?", "declaração de IR este ano", "emitir o DARF"]) {
      expect(heuristicPlan(q).agents).toEqual(["tax"]);
    }
  });

  it("falsos positivos: 'ir' verbo, 'impostor' e 'IR' sozinho (minúsculas perdem a caixa) não acionam tax", () => {
    for (const q of ["devo ir ao banco amanhã?", "impostor", "(IR)"]) {
      expect(heuristicPlan(q).agents).toEqual([]);
    }
  });

  it("tax: declaração de IR, IRPF, impostos e pós-imposto", () => {
    for (const q of ["declaração de IR", "IRPF", "meus impostos", "valor pós-imposto"]) {
      expect(heuristicPlan(q).agents).toEqual(["tax"]);
    }
  });

  it("assessores/assessoras casam; meta junto de pontuação casa", () => {
    expect(heuristicPlan("falar com os assessores").agents).toEqual(["assessor_liaison"]);
    expect(heuristicPlan("falar com as assessoras").agents).toEqual(["assessor_liaison"]);
    expect(heuristicPlan("minha meta, hoje").agents).toEqual(["strategist"]);
  });

  it("aposentadoria e meta → strategist", () => {
    expect(heuristicPlan("minha aposentadoria").agents).toEqual(["strategist"]);
    expect(heuristicPlan("qual a meta?").agents).toEqual(["strategist"]);
    expect(heuristicPlan("minhas metas").agents).toEqual(["strategist"]);
  });

  it("pesquise na base / o que diz a fonte → researcher", () => {
    expect(heuristicPlan("pesquise na base sobre FIIs").agents).toEqual(["researcher"]);
    expect(heuristicPlan("o que diz a fonte?").agents).toEqual(["researcher"]);
  });

  it("pergunte ao assessor → assessor_liaison", () => {
    expect(heuristicPlan("pergunte ao assessor").agents).toEqual(["assessor_liaison"]);
    expect(heuristicPlan("fale com a assessora").agents).toEqual(["assessor_liaison"]);
  });

  it("limite de palavra: metade, cometa, irmão, assessoria não acionam ninguém", () => {
    for (const q of ["metade", "cometa", "irmão", "assessoria", "fontes", "darfs"]) {
      expect(heuristicPlan(q).agents).toEqual([]);
    }
  });

  it("corta em 3 na ordem fixa: imposto + risco + aposentadoria + projeção + assessor → [risk, predictor, strategist]", () => {
    const plan = heuristicPlan("imposto, risco, aposentadoria, projeção e pergunte ao assessor");
    expect(MAX_SPECIALISTS).toBe(3);
    expect(plan.agents).toEqual(["risk", "predictor", "strategist"]);
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

  it("normalizePlan corta em 3 e mantém a ordem do modelo depois de deduplicar", () => {
    const plan = normalizePlan(
      {
        complexity: "complexa",
        agents: ["tax", "tax", "researcher", "insight", "risk", "predictor"],
        wantsExecution: false,
        rationale: "x",
      },
      "oi",
    );
    expect(plan?.agents).toEqual(["tax", "researcher", "insight"]);
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

describe("CLASSIFIER_PROMPT", () => {
  it("o prompt do classificador lista os sete especialistas e o limite de 3", () => {
    for (const a of [
      "insight",
      "predictor",
      "risk",
      "strategist",
      "tax",
      "researcher",
      "assessor_liaison",
    ]) {
      expect(CLASSIFIER_PROMPT).toContain(a);
    }
    expect(CLASSIFIER_PROMPT).toContain("no máximo 3");
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
