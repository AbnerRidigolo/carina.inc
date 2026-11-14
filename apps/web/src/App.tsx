import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { ApiProblemError, apiFetch, isAbortError, onUnauthorized } from "./api/client";
import { describeApiError } from "./api/errors";
import { type ClientSummary, ClientListSchema } from "./api/schemas";
import styles from "./App.module.css";
import { ChatView } from "./features/chat/ChatView";
import { ConnectScreen } from "./features/connect/ConnectScreen";
import { InboxPanel } from "./features/inbox/InboxPanel";
import { PortfolioPanel } from "./features/portfolio/PortfolioPanel";
import { UsagePanel } from "./features/usage/UsagePanel";
import { createEventBus, type PanelSignal } from "./state/event-bus";
import { clearApiKey, getApiKey, maskKey, subscribeApiKey } from "./state/session";
import ui from "./styles/ui.module.css";

export function App() {
  const apiKey = useSyncExternalStore(subscribeApiKey, getApiKey, () => null);
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const bus = useMemo(() => createEventBus<PanelSignal>(), []);
  const selectId = useId();

  // Qualquer 401 da sessão (chave revogada/expirada) volta para a tela de conexão.
  useEffect(
    () =>
      onUnauthorized(() => {
        clearApiKey();
        setClients(null);
        setSelected(undefined);
        setNotice("Chave inválida ou expirada. Informe a chave de novo.");
      }),
    [],
  );

  // Recarregou a página com a chave ainda no sessionStorage: busca os clientes.
  useEffect(() => {
    if (!apiKey || clients !== null) return;
    const ctrl = new AbortController();
    setLoadError(undefined);
    apiFetch("/api/clients", ClientListSchema, { signal: ctrl.signal })
      .then((list) => {
        if (!ctrl.signal.aborted) setClients(list);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isAbortError(err)) return;
        if (err instanceof ApiProblemError && err.status === 401) return; // onUnauthorized cuida
        setLoadError(describeApiError(err));
      });
    return () => ctrl.abort();
  }, [apiKey, clients]);

  const clientId = selected ?? clients?.[0]?.externalId;

  if (!apiKey) {
    return (
      <ConnectScreen
        notice={notice}
        onConnected={(list) => {
          setNotice(undefined);
          setClients(list);
        }}
      />
    );
  }

  function logout() {
    clearApiKey();
    setClients(null);
    setSelected(undefined);
    setNotice(undefined);
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1>CARINA</h1>
        <div className={styles.controls}>
          <div className={ui.field}>
            <label htmlFor={selectId}>Cliente</label>
            <select
              id={selectId}
              value={clientId ?? ""}
              disabled={!clients || clients.length === 0}
              onChange={(e) => setSelected(e.target.value)}
            >
              {(clients ?? []).map((c) => (
                <option key={c.id} value={c.externalId}>
                  {c.externalId}
                </option>
              ))}
            </select>
          </div>
          <span className={styles.key} title="Chave desta sessão (parcial)">
            {maskKey(apiKey)}
          </span>
          <button type="button" className={ui.button} onClick={logout}>
            Sair
          </button>
        </div>
      </header>

      {loadError ? (
        <div role="alert" className={ui.alert}>
          {loadError}
        </div>
      ) : null}
      {clients === null && !loadError ? <p role="status">Carregando clientes…</p> : null}
      {clients !== null && clients.length === 0 ? (
        <p role="status">Esta chave ainda não tem clientes cadastrados.</p>
      ) : null}

      {clientId ? (
        <div className={styles.columns}>
          <div className={styles.column}>
            <ChatView key={clientId} clientId={clientId} bus={bus} />
          </div>
          <div className={styles.column}>
            <InboxPanel key={`inbox-${clientId}`} clientId={clientId} bus={bus} />
            <PortfolioPanel key={`portfolio-${clientId}`} clientId={clientId} />
            <UsagePanel bus={bus} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
