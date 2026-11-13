import { MAX_CHAT_MESSAGE_CHARS } from "@carina/shared";
import { useCallback, useEffect, useId, useReducer, useRef, useState, type FormEvent } from "react";
import { messageForCode } from "../../api/errors";
import { type ChatConnection, type ChatStatus, connectChat } from "../../api/ws";
import type { SignalBus } from "../../state/event-bus";
import ui from "../../styles/ui.module.css";
import { formatBrl } from "../../util/format";
import { AgentCard } from "./AgentCard";
import styles from "./ChatView.module.css";
import { isActive, turnsReducer } from "./turns";

const WORK_LABELS: Record<string, string> = {
  query: "consulta",
  analysis: "análise",
  multi_agent_analysis: "análise multiagente",
  optimization: "otimização",
  execution: "execução",
  data_query: "consulta de dados",
  data_ingestion: "ingestão de dados",
  evaluation: "avaliação",
  backtest: "backtest",
};
const SEVERITY_LABELS = { info: "info", warning: "atenção", violation: "violação" } as const;
const SEVERITY_CLASS = {
  info: ui.badgeInfo,
  warning: ui.badgeWarning,
  violation: ui.badgeViolation,
} as const;

const CONNECTION_LABELS: Partial<Record<ChatStatus["state"], string>> = {
  connecting: "Conectando…",
  open: "Conectado",
  reconnecting: "Reconectando…",
};

function connectionProblem(status: ChatStatus): string | undefined {
  switch (status.state) {
    case "unauthorized":
      return "Chave inválida ou expirada. Saia e informe a chave de novo.";
    case "forbidden":
      return "Esta chave não tem o escopo chat, necessário para conversar.";
    case "offline":
      return "Conexão perdida. Recarregue a página para tentar de novo.";
    default:
      return undefined;
  }
}

interface Props {
  clientId: string;
  bus: SignalBus;
}

/** Conversa em streaming com os agentes de um cliente (um socket por cliente: o pai usa `key`). */
export function ChatView({ clientId, bus }: Props) {
  const [turns, dispatch] = useReducer(turnsReducer, []);
  const [status, setStatus] = useState<ChatStatus>({ state: "connecting" });
  const [protocolError, setProtocolError] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const connection = useRef<ChatConnection | null>(null);
  const threadId = useRef<string | undefined>(undefined);
  const lastState = useRef<ChatStatus["state"]>("connecting");
  const fieldId = useId();

  useEffect(() => {
    const ctrl = new AbortController();
    connectChat({
      clientId,
      signal: ctrl.signal,
      onEvent: (event) => {
        if (event.type === "done") threadId.current = event.threadId;
        dispatch({ type: "event", event });
        bus.publish(event);
      },
      onStatus: (next) => {
        if (next.state === "protocol_error") return setProtocolError(true);
        const was = lastState.current;
        lastState.current = next.state;
        // Caiu no meio de um turno: os eventos que faltam nunca chegam; libera o campo.
        if (
          was === "open" &&
          (next.state === "reconnecting" ||
            next.state === "offline" ||
            next.state === "unauthorized")
        ) {
          dispatch({ type: "turn_interrupted" });
        }
        setStatus(next);
        if (next.state === "open") bus.publish({ type: "socket_open" });
      },
    })
      .then((conn) => {
        if (ctrl.signal.aborted) conn.close();
        else connection.current = conn;
      })
      .catch(() => {
        // desistiu ou foi cancelado: o status final já foi entregue por onStatus
      });
    return () => {
      ctrl.abort();
      connection.current = null;
    };
  }, [clientId, bus]);

  const last = turns.at(-1);
  const busy = isActive(last);
  const canType = status.state === "open" && !busy;
  const problem =
    connectionProblem(status) ??
    sendError ??
    (last?.error
      ? `${messageForCode(last.error.code)} (rastreio: ${last.error.traceId})`
      : undefined) ??
    (protocolError ? "Uma mensagem inválida do servidor foi ignorada." : undefined);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const message = draft.trim();
      const conn = connection.current;
      if (!message || !conn || !canType) return;
      setSendError(undefined);
      setProtocolError(false);
      try {
        conn.send({
          clientId,
          message,
          ...(threadId.current ? { threadId: threadId.current } : {}),
        });
      } catch {
        setSendError("Não foi possível enviar agora: a conexão não está pronta.");
        return;
      }
      dispatch({ type: "ask", question: message });
      setDraft("");
    },
    [draft, canType, clientId],
  );

  return (
    <section className={ui.panel} aria-labelledby={`${fieldId}-title`}>
      <div className={ui.panelHeader}>
        <h2 id={`${fieldId}-title`}>Conversa</h2>
        <span className={styles.status} role="status">
          {CONNECTION_LABELS[status.state] ?? ""}
        </span>
      </div>

      <div className={styles.log} role="log" aria-live="polite" aria-label="Mensagens da conversa">
        {turns.length === 0 ? (
          <p className={ui.muted}>Pergunte algo sobre a carteira de {clientId}.</p>
        ) : null}
        {turns.map((turn) => (
          <div key={turn.id} className={styles.turn}>
            <p className={`${styles.question} ${ui.plain}`}>{turn.question}</p>
            {turn.agents.map((view) => (
              <AgentCard key={view.agent} view={view} />
            ))}
            {turn.done ? (
              <div className={styles.footer}>
                <span>
                  Custo: <strong>{formatBrl(turn.done.priceBrl)}</strong> (
                  {WORK_LABELS[turn.done.workType] ?? turn.done.workType})
                </span>
                {turn.done.status === "awaiting_approval" ? (
                  <span className={`${ui.badge} ${ui.badgeWarning}`}>Aguardando aprovação</span>
                ) : null}
                {turn.done.flags.length > 0 ? (
                  <ul className={styles.flags} aria-label="Alertas de compliance">
                    {turn.done.flags.map((flag, i) => (
                      <li
                        key={`${flag.code}-${i}`}
                        className={`${ui.badge} ${SEVERITY_CLASS[flag.severity]}`}
                      >
                        {SEVERITY_LABELS[flag.severity]}: {flag.code}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {problem ? (
        <div role="alert" className={ui.alert}>
          {problem}
        </div>
      ) : null}

      <form className={styles.form} onSubmit={submit}>
        <div className={ui.field}>
          <label htmlFor={fieldId}>Mensagem</label>
          <textarea
            id={fieldId}
            rows={3}
            maxLength={MAX_CHAT_MESSAGE_CHARS}
            value={draft}
            disabled={!canType}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey))
                e.currentTarget.form?.requestSubmit();
            }}
          />
        </div>
        <div className={styles.formRow}>
          <span className={styles.status}>Ctrl+Enter envia</span>
          <button
            type="submit"
            className={`${ui.button} ${ui.primary}`}
            disabled={!canType || !draft.trim()}
          >
            Enviar
          </button>
        </div>
      </form>
    </section>
  );
}
