import {
  type AgentName,
  AssessorBriefSchema,
  CashFlowForecastSchema,
  MoneySchema,
  RiskAssessmentSchema,
  StrategyPlanSchema,
  TaxAdviceSchema,
} from "@carina/shared";
import { z } from "zod";
import ui from "../../styles/ui.module.css";
import { formatBrl, formatNumber } from "../../util/format";
import styles from "./AgentCard.module.css";
import type { AgentView } from "./turns";

const AGENT_LABELS: Record<AgentName, string> = {
  insight: "Insight",
  predictor: "Predictor",
  risk: "Risk",
  strategist: "Strategist",
  tax: "Tributário",
  researcher: "Pesquisa",
  assessor_liaison: "Assessor",
  navigator: "Navigator",
  executor: "Executor",
};

const ExecutorResultSchema = z.object({
  action: z.string(),
  risk: z.string().optional(),
  valueBrl: MoneySchema.optional(),
  rationale: z.string().optional(),
  status: z.string().optional(),
});
/**
 * Falha do agente. `message` (opcional) é a frase fixa do servidor para a ordem que não pôde ser
 * proposta (falha do preço de servidor); entra como texto, como todo o resto.
 */
const FailureSchema = z.object({
  failed: z.literal(true),
  message: z.string().min(1).max(300).optional(),
});
const TextSchema = z.string();

const EXECUTOR_STATUS: Record<string, string> = {
  pending_approval: "Aguardando aprovação no painel de aprovações",
  succeeded: "Executada",
  failed: "Falhou",
};

/**
 * Todo texto aqui (tokens, resultados, listas) é texto de modelo, não confiável: só entra no DOM
 * como nó de texto do React. Nunca HTML, nunca link automático. Resultado fora do schema do agente
 * não é renderizado (aviso no lugar).
 */
function Result({ agent, result }: { agent: AgentName; result: unknown }) {
  const failure = FailureSchema.safeParse(result);
  if (failure.success) {
    return (
      <p className={ui.muted}>
        {failure.data.message ?? "Este agente não conseguiu concluir a análise."}
      </p>
    );
  }
  if (agent === "predictor") {
    const parsed = CashFlowForecastSchema.safeParse(result);
    if (parsed.success) {
      return (
        <>
          <div className={ui.tableWrap}>
            <table className={ui.table} aria-label="Cenários de fluxo de caixa">
              <thead>
                <tr>
                  <th scope="col">Cenário</th>
                  <th scope="col" className={ui.num}>
                    Horizonte
                  </th>
                  <th scope="col" className={ui.num}>
                    Fluxo líquido
                  </th>
                  <th scope="col" className={ui.num}>
                    Confiança
                  </th>
                  <th scope="col">Premissas</th>
                </tr>
              </thead>
              <tbody>
                {parsed.data.scenarios.map((s, i) => (
                  <tr key={`${s.name}-${i}`}>
                    <th scope="row">{s.name}</th>
                    <td className={ui.num}>{s.horizonMonths} meses</td>
                    <td className={ui.num}>{formatBrl(s.projectedNetFlowBrl)}</td>
                    <td className={ui.num}>{formatNumber(Math.round(s.confidence * 100))}%</td>
                    <td>{s.assumptions.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={ui.plain}>{parsed.data.narrative}</p>
        </>
      );
    }
  } else if (agent === "risk") {
    const parsed = RiskAssessmentSchema.safeParse(result);
    if (parsed.success) {
      const r = parsed.data;
      return (
        <>
          <p>
            Valor em risco (VaR):{" "}
            <span className={styles.bigValue}>{formatBrl(r.valueAtRiskBrl)}</span>
          </p>
          <p>Desvio da carteira-alvo: {formatNumber(r.driftPct)}%</p>
          <List title="Correlações principais" items={r.topCorrelations} />
          <List title="Testes de estresse" items={r.stressFindings} />
          <List title="Sugestões de rebalanceamento" items={r.rebalanceSuggestions} />
        </>
      );
    }
  } else if (agent === "strategist") {
    const parsed = StrategyPlanSchema.safeParse(result);
    if (parsed.success) {
      const p = parsed.data;
      return (
        <>
          <div className={ui.tableWrap}>
            <table className={ui.table} aria-label="Alocação-alvo">
              <thead>
                <tr>
                  <th scope="col">Classe de ativo</th>
                  <th scope="col" className={ui.num}>
                    Alocação
                  </th>
                </tr>
              </thead>
              <tbody>
                {p.targetAllocation.map((a, i) => (
                  <tr key={`${a.assetClass}-${i}`}>
                    <th scope="row">{a.assetClass}</th>
                    <td className={ui.num}>{formatNumber(a.pct)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.milestones.length > 0 ? (
            <div className={styles.sub}>
              <h4>Marcos</h4>
              <ul>
                {p.milestones.map((m, i) => (
                  <li key={i} className={ui.plain}>
                    {m.goal}: até {m.byYear}, probabilidade de{" "}
                    {formatNumber(Math.round(m.successProbability * 100))}%
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <List title="Premissas" items={p.assumptions} />
          <p className={ui.plain}>{p.narrative}</p>
        </>
      );
    }
  } else if (agent === "tax") {
    const parsed = TaxAdviceSchema.safeParse(result);
    if (parsed.success) {
      const t = parsed.data;
      return (
        <>
          <p>
            IR estimado: <span className={styles.bigValue}>{formatBrl(t.estimatedTaxBrl)}</span>
          </p>
          <List title="Oportunidades de compensação" items={t.harvestingOpportunities} />
          <div className={styles.sub}>
            <h4>Exterior x Brasil</h4>
            <p className={ui.plain}>{t.offshoreVsBr}</p>
          </div>
          <List title="Ações sugeridas" items={t.actions} />
          <p className={ui.plain}>{t.narrative}</p>
          {t.consultAccountant ? (
            <p role="note">
              <strong>Consulte um contador antes de agir.</strong>
            </p>
          ) : null}
        </>
      );
    }
  } else if (agent === "assessor_liaison") {
    const parsed = AssessorBriefSchema.safeParse(result);
    if (parsed.success) {
      const b = parsed.data;
      return (
        <>
          <div className={styles.sub}>
            <h4>Perguntas para o assessor</h4>
            <ol>
              {b.questions.map((q, i) => (
                <li key={i} className={ui.plain}>
                  {q}
                  {b.sharedData[i] ? (
                    <>
                      <br />
                      <span className={ui.muted}>{b.sharedData[i]}</span>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
          <p className={ui.plain}>{b.narrative}</p>
          <p role="note">Rascunho: nada foi enviado ao assessor.</p>
        </>
      );
    }
  } else if (agent === "executor") {
    const parsed = ExecutorResultSchema.safeParse(result);
    if (parsed.success) {
      const e = parsed.data;
      return (
        <>
          <p className={ui.plain}>
            Ação proposta: <strong>{e.action}</strong>
            {e.valueBrl ? ` (${formatBrl(e.valueBrl)})` : ""}
          </p>
          {e.rationale ? <p className={ui.plain}>{e.rationale}</p> : null}
          {e.status ? <p>Situação: {EXECUTOR_STATUS[e.status] ?? "Em processamento"}</p> : null}
        </>
      );
    }
  } else {
    const parsed = TextSchema.safeParse(result);
    if (parsed.success) return <p className={ui.plain}>{parsed.data}</p>;
  }
  return <p className={ui.muted}>Resultado em formato inesperado; não foi exibido.</p>;
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.sub}>
      <h4>{title}</h4>
      <ul>
        {items.map((item, i) => (
          <li key={i} className={ui.plain}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentCard({ view }: { view: AgentView }) {
  const label = AGENT_LABELS[view.agent];
  // Texto em streaming enquanto não há resultado; o resultado final (estruturado) o substitui.
  const showStream = !view.hasResult && view.text !== "";
  return (
    <section className={styles.card} aria-label={`Agente ${label}`}>
      <h3>{label}</h3>
      {view.status === "thinking" && !showStream ? (
        <p className={styles.thinking}>pensando…</p>
      ) : null}
      {showStream ? <p className={ui.plain}>{view.text}</p> : null}
      {view.hasResult ? <Result agent={view.agent} result={view.result} /> : null}
    </section>
  );
}
