/**
 * Responders determinísticos dos agentes para `LLM_MODE=mock`, registrados no
 * `MockResponderRegistry`. Eles leem as MESMAS mensagens que um modelo real receberia (achadas
 * pelo id da mensagem, nunca pelo histórico, que é conteúdo do cliente).
 *
 * NÃO registra o `classifier`: o responder dele nasce com a heurística da Task 18.
 */
import type { BaseMessage } from "@langchain/core/messages";
import type {
  ActionProposal,
  AssessorBrief,
  CashFlowForecast,
  RiskAssessment,
  StrategyPlan,
  TaxAdvice,
} from "@carina/shared";
import type { MockResponder, MockResponderRegistry } from "../llm/mock-models.js";
import {
  CONTEXT_MESSAGE_ID,
  contentText,
  FONTE_RE,
  QUESTION_MESSAGE_ID,
  RESULTADO_RE,
  RESULTS_MESSAGE_ID,
} from "./agent.js";

export const MOCK_DISCLAIMER = "Isto não constitui recomendação de investimento.";

/** Preço unitário fixo do mock para valorar `place_trade`. */
const MOCK_UNIT_PRICE_CENTS = 3000n;

const TRADE_RE = /(compr|vend)\w*\s+(\d+)\s+(?:ações\s+(?:de|da|do)\s+)?([A-Z]{4}\d{1,2})/i;

const textById = (messages: BaseMessage[], id: string): string =>
  contentText(messages.find((m) => m.id === id)?.content);

const lastQuestion = (messages: BaseMessage[]): string => textById(messages, QUESTION_MESSAGE_ID);

const navigator: MockResponder = ({ messages }) => {
  const results = textById(messages, RESULTS_MESSAGE_ID);
  if (results) return synthesize({ mockKey: "synthesize", messages });
  return "Entendi sua pergunta. Vou consultar a base de conhecimento do cliente para responder com segurança.";
};

/** Texto de um resultado: `narrative` se for um JSON com ela; senão o conteúdo como está. */
function resultSummary(content: string): string {
  try {
    const v: unknown = JSON.parse(content);
    if (typeof v === "object" && v !== null) {
      const n = (v as { narrative?: unknown }).narrative;
      if (typeof n === "string") return n;
    }
  } catch {
    // não é JSON: usa o texto
  }
  return content;
}

const synthesize: MockResponder = ({ messages }) => {
  const parts: string[] = [];
  for (const m of textById(messages, RESULTS_MESSAGE_ID).matchAll(RESULTADO_RE)) {
    const [, agent = "", status = "", content = ""] = m;
    parts.push(
      status === "falhou"
        ? `A análise de ${agent} falhou e não pôde ser incluída.`
        : resultSummary(content),
    );
  }
  const body = parts.join(" ");
  return `Resumo: ${body}${body ? " " : ""}${MOCK_DISCLAIMER}`;
};

const insight: MockResponder = ({ messages }) => {
  const titles = [...textById(messages, CONTEXT_MESSAGE_ID).matchAll(FONTE_RE)]
    .slice(0, 3)
    .map((m) => m[1] ?? "");
  const list = titles.length > 0 ? titles.join(", ") : "nenhum documento encontrado";
  return `Composição da carteira: ${list} (fonte: base de conhecimento).`;
};

const predictor: MockResponder = () => {
  const assumptions = ["inflação em linha com a meta", "juros estáveis", "câmbio sem choques"];
  const scenario = (name: string, flow: string, confidence: number) => ({
    name,
    horizonMonths: 12,
    assumptions,
    projectedNetFlowBrl: flow,
    confidence,
  });
  const out: CashFlowForecast = {
    scenarios: [
      scenario("base", "120000.00", 0.6),
      scenario("otimista", "180000.00", 0.3),
      scenario("pessimista", "60000.00", 0.1),
    ],
    narrative:
      "Esta é uma estimativa de fluxo de caixa para 12 meses, construída a partir das premissas " +
      "listadas em cada cenário; não é garantia de resultado.",
  };
  return out;
};

const risk: MockResponder = () => {
  const out: RiskAssessment = {
    driftPct: 4.5,
    valueAtRiskBrl: "85000.00",
    topCorrelations: [],
    stressFindings: [],
    rebalanceSuggestions: ["Reduzir a concentração em renda variável até o alvo de alocação."],
  };
  return out;
};

const strategist: MockResponder = () => {
  const out: StrategyPlan = {
    targetAllocation: [
      { assetClass: "renda fixa", pct: 50 },
      { assetClass: "renda variável", pct: 30 },
      { assetClass: "multimercado", pct: 10 },
      { assetClass: "exterior", pct: 10 },
    ],
    milestones: [{ goal: "independência financeira", byYear: 2040, successProbability: 0.7 }],
    assumptions: ["inflação em linha com a meta", "retorno real de 4% ao ano"],
    narrative:
      "Esta é uma estimativa de longo prazo baseada nas premissas listadas; considere validar " +
      "com um planejador financeiro.",
  };
  return out;
};

const tax: MockResponder = () => {
  const out: TaxAdvice = {
    estimatedTaxBrl: "12000.00",
    harvestingOpportunities: ["Compensar prejuízos realizados com ganhos em renda variável."],
    offshoreVsBr: "Estimativa: a tributação offshore exige comparação caso a caso com o Brasil.",
    actions: ["Revisar prejuízos a compensar antes do fechamento do ano."],
    consultAccountant: true,
    narrative:
      "Estimativa de IR baseada nas posições conhecidas; não é aconselhamento tributário " +
      "formal, consulte um contador.",
  };
  return out;
};

const researcher: MockResponder = ({ messages }) => {
  const title = [...textById(messages, CONTEXT_MESSAGE_ID).matchAll(FONTE_RE)][0]?.[1];
  if (!title) return "A base de conhecimento não tem a informação solicitada.";
  return `Segundo "${title}" (fonte: base de conhecimento), confiança média; data não informada.`;
};

const assessorLiaison: MockResponder = ({ messages }) => {
  const title = [...textById(messages, CONTEXT_MESSAGE_ID).matchAll(FONTE_RE)][0]?.[1];
  const ref = title ? ` (ref.: ${title})` : "";
  const out: AssessorBrief = {
    questions: [`Quais são as condições atuais dos produtos de renda fixa disponíveis${ref}?`],
    sharedData: ["Revela o interesse do cliente em renda fixa."],
    narrative: "Rascunho de pergunta ao assessor; nada foi enviado.",
  };
  return out;
};

const executor: MockResponder = ({ messages }) => {
  const question = lastQuestion(messages);
  const m = TRADE_RE.exec(question);
  if (m) {
    const [, verb = "", qty = "0", asset = ""] = m;
    const side = verb.toLowerCase() === "compr" ? "buy" : "sell";
    const cents = BigInt(qty) * MOCK_UNIT_PRICE_CENTS;
    const valueBrl = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
    const out: ActionProposal = {
      action: "place_trade",
      payload: { side, assetCode: asset.toUpperCase(), quantity: Number(qty) },
      valueBrl,
      rationale: "Ordem proposta a partir do pedido do cliente; aguarda aprovação humana.",
    };
    return out;
  }
  const out: ActionProposal = {
    action: "create_alert",
    payload: { description: question.slice(0, 200) },
    valueBrl: "0.00",
    rationale: "Pedido sem ordem reconhecida; proposto um alerta (reversível).",
  };
  return out;
};

/** Registra (idempotente) os responders dos agentes; os `mockKey` são os nomes dos agentes. */
export function registerAgentMockResponders(registry: MockResponderRegistry): void {
  const responders: Record<string, MockResponder> = {
    navigator,
    synthesize,
    insight,
    predictor,
    risk,
    strategist,
    tax,
    researcher,
    assessor_liaison: assessorLiaison,
    executor,
  };
  for (const [key, responder] of Object.entries(responders)) {
    if (!registry.has(key)) registry.register(key, responder);
  }
}
