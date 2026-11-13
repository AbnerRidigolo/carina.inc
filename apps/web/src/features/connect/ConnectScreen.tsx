import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiProblemError, apiFetch } from "../../api/client";
import { describeApiError } from "../../api/errors";
import { type ClientSummary, ClientListSchema } from "../../api/schemas";
import { setApiKey } from "../../state/session";
import ui from "../../styles/ui.module.css";
import styles from "./ConnectScreen.module.css";

interface Props {
  /** Chave validada e guardada na sessão; recebe os clientes que a validação já trouxe. */
  onConnected: (clients: ClientSummary[]) => void;
  /** Aviso de uma sessão que acabou (ex.: chave expirada). */
  notice?: string | undefined;
}

export function ConnectScreen({ onConnected, notice }: Props) {
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const mounted = useRef(true);
  const inputId = useId();
  const helpId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const candidate = key.trim();
    if (!candidate || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const clients = await apiFetch("/api/clients", ClientListSchema, { apiKey: candidate });
      // Só guarda a chave depois de validada; o App assume daqui.
      setApiKey(candidate);
      onConnected(clients);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiProblemError && err.status === 401) setError("Chave inválida.");
      else if (err instanceof ApiProblemError && err.status === 403) {
        setError("Esta chave não tem o escopo chat, necessário para usar o painel.");
      } else setError(describeApiError(err));
      setPending(false);
    }
  }

  return (
    <main className={styles.wrap}>
      <section className={`${ui.panel} ${styles.card}`} aria-labelledby={`${inputId}-title`}>
        <h1 id={`${inputId}-title`}>CARINA</h1>
        <p className={ui.muted}>Informe a chave de API do seu tenant para continuar.</p>
        {notice ? (
          <div role="alert" className={ui.alert}>
            {notice}
          </div>
        ) : null}
        <form className={styles.form} onSubmit={(e) => void submit(e)}>
          <div className={ui.field}>
            <label htmlFor={inputId}>Chave de API</label>
            <input
              id={inputId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-describedby={helpId}
              required
            />
          </div>
          {error ? (
            <div role="alert" className={ui.alert}>
              {error}
            </div>
          ) : null}
          <button
            type="submit"
            className={`${ui.button} ${ui.primary}`}
            disabled={pending || !key.trim()}
          >
            {pending ? "Validando…" : "Conectar"}
          </button>
        </form>
        <p id={helpId} className={`${ui.muted} ${styles.help}`}>
          A chave fica só nesta aba (sessionStorage) e é enviada apenas no cabeçalho de autorização.
          Na demo local (docker compose) use <code>DEMO_APP_KEY</code> (escopos chat e data:write)
          ou <code>DEMO_APPROVER_KEY</code> (chat e inbox:decide, necessária para aprovar ações); os
          valores públicos estão na seção &ldquo;Demo local&rdquo; do README.
        </p>
      </section>
    </main>
  );
}
