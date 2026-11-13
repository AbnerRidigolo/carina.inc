import {
  AuditEventViewSchema,
  UsageSummarySchema,
  type AuditEventView,
  type UsageSummary,
} from "@carina/shared";
import { useCallback, useEffect, useId, useState } from "react";
import { z } from "zod";
import { apiFetch, isAbortError } from "../../api/client";
import { describeApiError } from "../../api/errors";
import type { SignalBus } from "../../state/event-bus";
import ui from "../../styles/ui.module.css";
import { formatBrl, formatDateTime, formatMonth } from "../../util/format";
import styles from "./UsagePanel.module.css";

const AuditListSchema = z.array(AuditEventViewSchema);
const AUDIT_LIMIT = 20;
const MAX_QUERY_CHARS = 200;

const WORK_LABELS: Record<string, string> = {
  query: "Consulta",
  analysis: "Análise",
  multi_agent_analysis: "Análise multiagente",
  optimization: "Otimização",
  execution: "Execução",
  data_query: "Consulta de dados",
  data_ingestion: "Ingestão de dados",
  evaluation: "Avaliação",
  backtest: "Backtest",
};
const SEVERITY_LABELS = { info: "info", warning: "atenção", violation: "violação" } as const;
const SEVERITY_CLASS = {
  info: ui.badgeInfo,
  warning: ui.badgeWarning,
  violation: ui.badgeViolation,
} as const;

const clip = (text: string) =>
  text.length > MAX_QUERY_CHARS ? `${text.slice(0, MAX_QUERY_CHARS)}…` : text;

/** Uso do mês e últimos eventos de auditoria; recarrega quando um turno do chat termina. */
export function UsagePanel({ bus }: { bus: SignalBus }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [audit, setAudit] = useState<AuditEventView[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const titleId = useId();

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const [u, a] = await Promise.all([
        apiFetch("/api/usage", UsageSummarySchema, { signal }),
        apiFetch(`/api/audit?limit=${AUDIT_LIMIT}`, AuditListSchema, { signal }),
      ]);
      if (signal.aborted) return;
      setUsage(u);
      setAudit(a);
      setError(undefined);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return;
      setError(`Não foi possível carregar o uso. ${describeApiError(err)}`);
    }
  }, []);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, version]);

  useEffect(
    () =>
      bus.subscribe((signal) => {
        if (signal.type === "done") setVersion((v) => v + 1);
      }),
    [bus],
  );

  return (
    <section className={ui.panel} aria-labelledby={titleId}>
      <div className={ui.panelHeader}>
        <h2 id={titleId}>Uso e auditoria</h2>
        <button type="button" className={ui.button} onClick={() => setVersion((v) => v + 1)}>
          Atualizar
        </button>
      </div>
      {error ? (
        <div role="alert" className={ui.alert}>
          {error}
        </div>
      ) : null}
      {!usage && !error ? <p className={ui.muted}>Carregando…</p> : null}

      {usage ? (
        <>
          <p className={ui.muted}>Mês: {formatMonth(usage.month)}</p>
          <div className={styles.totals}>
            <span className={styles.big}>{formatBrl(usage.totalBrl)}</span>
            <span>{usage.resolutions} resoluções</span>
          </div>
          <div className={ui.tableWrap}>
            <table className={ui.table} aria-label="Uso por tipo de trabalho">
              <thead>
                <tr>
                  <th scope="col">Tipo</th>
                  <th scope="col" className={ui.num}>
                    Qtd.
                  </th>
                  <th scope="col" className={ui.num}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(usage.byWorkType).map(([type, row]) => (
                  <tr key={type}>
                    <th scope="row">{WORK_LABELS[type] ?? type}</th>
                    <td className={ui.num}>{row.count}</td>
                    <td className={ui.num}>{formatBrl(row.totalBrl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {audit ? (
        <>
          <h3>Últimos eventos de auditoria</h3>
          {audit.length === 0 ? <p className={ui.muted}>Nenhum evento ainda.</p> : null}
          <ul className={ui.list}>
            {audit.map((event) => (
              <li key={event.id} className={styles.event}>
                <p className={ui.plain}>{clip(event.query)}</p>
                <p className={styles.meta}>
                  {formatDateTime(event.createdAt)} · {event.channel} ·{" "}
                  {event.agents.join(", ") || "sem agentes"} · {event.durationMs} ms
                </p>
                {event.flags.length > 0 ? (
                  <ul className={styles.flagList} aria-label="Flags de compliance">
                    {event.flags.map((flag, i) => (
                      <li
                        key={`${flag.code}-${i}`}
                        data-severity={flag.severity}
                        className={`${ui.badge} ${SEVERITY_CLASS[flag.severity]}`}
                        title={flag.detail}
                      >
                        {SEVERITY_LABELS[flag.severity]}:{" "}
                        <span className={ui.plain}>{flag.code}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
