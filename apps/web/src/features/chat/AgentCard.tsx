import {
  type AgentName,
  CashFlowForecastSchema,
  MoneySchema,
  RiskAssessmentSchema,
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
const FailureSchema = z.object({ failed: z.literal(true) });
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
  if (FailureSchema.safeParse(result).success) {
    return <p className={ui.muted}>Este agente não conseguiu concluir a análise.</p>;
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
