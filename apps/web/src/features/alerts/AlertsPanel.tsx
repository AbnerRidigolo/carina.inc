import type { PortfolioAlert } from "@carina/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isAbortError, listAlerts } from "../../api/client";
import { describeApiError } from "../../api/errors";
import type { SignalBus } from "../../state/event-bus";
import ui from "../../styles/ui.module.css";
import {
  formatDateTime,
  formatDayMonth,
  formatPrice,
  formatVariationPct,
  saoPauloDate,
} from "../../util/format";
import styles from "./AlertsPanel.module.css";

const FOOTER =
  "Variação do dia em relação ao fechamento anterior. Não é recomendação de investimento.";

/**
 * Texto fixo e neutro: sem verbo de ação além de "caiu"/"subiu". Tudo entra como texto, nunca HTML.
 * "hoje" só quando o dia do pregão do alerta é hoje em São Paulo; senão, "em DD/MM".
 */
function alertText(alert: PortfolioAlert, today: string): string {
  const verb = alert.direction === "down" ? "caiu" : "subiu";
  const when = alert.tradingDay === today ? "hoje" : `em ${formatDayMonth(alert.tradingDay)}`;
  return `${alert.assetCode} ${verb} ${formatVariationPct(alert.changePct)}% ${when} (${formatPrice(alert.price)}).`;
}

/** Junta sem repetir `id`: o primeiro da lista vence e a ordem se mantém. */
function mergeUnique(first: PortfolioAlert[], then: PortfolioAlert[]): PortfolioAlert[] {
  const seen = new Set<string>();
  return [...first, ...then].filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

interface Props {
  clientId: string;
  bus: SignalBus;
}

/** Alertas de variação forte da carteira: lista da API e novos alertas chegando pelo socket. */
export function AlertsPanel({ clientId, bus }: Props) {
  const [alerts, setAlerts] = useState<PortfolioAlert[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  /** Anúncio do último alerta ao vivo (região `aria-live`, como no InboxPanel). */
  const [announcement, setAnnouncement] = useState("");
  const known = useRef<ReadonlySet<string>>(new Set());
  const titleId = useId();
  const ctrl = useRef<AbortController | null>(null);
  const moreLock = useRef(false);

  const load = useCallback(
    async (cursor?: string) => {
      ctrl.current?.abort();
      const own = new AbortController();
      ctrl.current = own;
      try {
        const page = await listAlerts(clientId, cursor, own.signal);
        if (own.signal.aborted) return;
        setError(undefined);
        setAlerts((prev) => mergeUnique(cursor === undefined ? [] : (prev ?? []), page.items));
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (own.signal.aborted || isAbortError(err)) return;
        setError(`Não foi possível carregar os alertas. ${describeApiError(err)}`);
        setAlerts((prev) => prev ?? []);
      }
    },
    [clientId],
  );

  useEffect(() => {
    void load();
    return () => ctrl.current?.abort();
  }, [load]);

  // Ids já na tela: um alerta ao vivo que já estava listado não é anunciado de novo.
  useEffect(() => {
    known.current = new Set(alerts?.map((a) => a.id));
  }, [alerts]);

  useEffect(
    () =>
      bus.subscribe((signal) => {
        if (signal.type === "portfolio_alert") {
          const live = signal.alert;
          if (!known.current.has(live.id)) {
            setAnnouncement(`Novo alerta: ${alertText(live, saoPauloDate(Date.now()))}`);
          }
          // Já listado (ex.: veio na API antes do evento): fica onde está.
          setAlerts((prev) =>
            prev?.some((a) => a.id === live.id) ? prev : mergeUnique([live], prev ?? []),
          );
        } else if (signal.type === "socket_open") {
          // Pode ter perdido alertas enquanto o socket estava fora: recarrega a primeira página.
          void load();
        }
      }),
    [bus, load],
  );

  async function loadMore() {
    if (nextCursor === null || moreLock.current) return;
    moreLock.current = true;
    setLoadingMore(true);
    try {
      await load(nextCursor);
    } finally {
      moreLock.current = false;
      setLoadingMore(false);
    }
  }

  const today = saoPauloDate(Date.now());

  return (
    <section className={ui.panel} aria-labelledby={titleId}>
      <div className={ui.panelHeader}>
        <h2 id={titleId}>Alertas da carteira</h2>
      </div>
      {error ? (
        <div role="alert" className={ui.alert}>
          {error}
        </div>
      ) : null}
      <div role="status" aria-live="polite">
        {announcement ? <p className={ui.notice}>{announcement}</p> : null}
      </div>
      {alerts === null && !error ? <p className={ui.muted}>Carregando…</p> : null}
      {alerts?.length === 0 && !error ? <p className={ui.muted}>Nenhum alerta.</p> : null}

      {alerts && alerts.length > 0 ? (
        <ul className={ui.list} aria-label="Alertas da carteira">
          {alerts.map((alert) => (
            <li key={alert.id} className={styles.alert}>
              {alertText(alert, today)}
              <small className={`${ui.muted} ${styles.time}`}>
                {formatDateTime(alert.createdAt)}
              </small>
            </li>
          ))}
        </ul>
      ) : null}

      {nextCursor !== null ? (
        <div className={styles.more}>
          <button
            type="button"
            className={ui.button}
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            Carregar mais
          </button>
        </div>
      ) : null}
      <p className={`${ui.muted} ${styles.footer}`}>{FOOTER}</p>
    </section>
  );
}
