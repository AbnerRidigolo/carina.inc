import { type ApprovalView, ApprovalViewSchema } from "@carina/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { ApiProblemError, apiFetch, isAbortError } from "../../api/client";
import { describeApiError } from "../../api/errors";
import type { SignalBus } from "../../state/event-bus";
import { subscribeApiKey } from "../../state/session";
import ui from "../../styles/ui.module.css";
import { formatBrl, formatDateTime } from "../../util/format";
import styles from "./InboxPanel.module.css";

const ApprovalListSchema = z.array(ApprovalViewSchema);
const MAX_PAYLOAD_CHARS = 2000;
const NO_PERMISSION = "Esta chave não pode aprovar";

interface Item {
  approval: ApprovalView;
  /** Decisão em voo (desabilita os botões do item: sem envio duplo). */
  sending?: "approve" | "reject";
  /** Passo de confirmação aberto (irreversível). */
  confirming?: boolean;
  /** Aprovada; falta o `approval_executed`. */
  awaitingExecution?: boolean;
  error?: string;
}

function payloadText(payload: ApprovalView["payload"]): string {
  const text = JSON.stringify(payload, null, 2);
  return text.length > MAX_PAYLOAD_CHARS ? `${text.slice(0, MAX_PAYLOAD_CHARS)}\n…(cortado)` : text;
}

interface Props {
  clientId: string;
  bus: SignalBus;
}

export function InboxPanel({ clientId, bus }: Props) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [canDecide, setCanDecide] = useState(true);
  const [conflict, setConflict] = useState<string | undefined>();
  const [notices, setNotices] = useState<string[]>([]);
  const titleId = useId();
  const alive = useRef(true);
  const loadCtrl = useRef<AbortController | null>(null);
  // Decisões em voo por id: trava síncrona contra duplo clique antes do re-render.
  const inFlight = useRef(new Set<string>());

  const load = useCallback(async () => {
    loadCtrl.current?.abort();
    const ctrl = new AbortController();
    loadCtrl.current = ctrl;
    try {
      const list = await apiFetch(
        `/api/clients/${encodeURIComponent(clientId)}/inbox`,
        ApprovalListSchema,
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return;
      setLoadError(undefined);
      // Lista nova com sucesso: o 403 anterior pode ter sido por outra causa; tenta de novo.
      setCanDecide(true);
      setItems((prev) => {
        const keep = new Map((prev ?? []).map((i) => [i.approval.id, i]));
        return list
          .filter((a) => a.status === "pending")
          .map((approval) => ({ ...keep.get(approval.id), approval }));
      });
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err)) return;
      setLoadError(`Não foi possível carregar as aprovações. ${describeApiError(err)}`);
      setItems((prev) => prev ?? []);
    }
  }, [clientId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      loadCtrl.current?.abort();
    };
  }, [load]);

  // Trocar a chave reabilita as decisões.
  useEffect(() => subscribeApiKey(() => setCanDecide(true)), []);

  useEffect(
    () =>
      bus.subscribe((signal) => {
        if (signal.type === "socket_open") {
          void load();
        } else if (signal.type === "approval_required") {
          const { approval } = signal;
          if (approval.clientId !== clientId || approval.status !== "pending") return;
          setItems((prev) =>
            (prev ?? []).some((i) => i.approval.id === approval.id)
              ? prev
              : [...(prev ?? []), { approval }],
          );
        } else if (signal.type === "approval_executed") {
          setItems((prev) => {
            if (!prev?.some((i) => i.approval.id === signal.approvalId)) return prev;
            return prev.filter((i) => i.approval.id !== signal.approvalId);
          });
          setNotices((prev) => [
            ...prev.slice(-2),
            signal.status === "succeeded"
              ? "Aprovação executada com sucesso."
              : "A execução da aprovação falhou.",
          ]);
        }
      }),
    [bus, clientId, load],
  );

  const patch = (id: string, change: Partial<Item>) =>
    setItems((prev) => prev?.map((i) => (i.approval.id === id ? { ...i, ...change } : i)) ?? prev);

  async function decide(approval: ApprovalView, approved: boolean) {
    const id = approval.id;
    if (inFlight.current.has(id) || !canDecide) return;
    inFlight.current.add(id);
    setConflict(undefined);
    patch(id, { sending: approved ? "approve" : "reject", error: undefined });
    try {
      const result = await apiFetch(
        `/api/inbox/${encodeURIComponent(id)}/decision`,
        ApprovalViewSchema,
        {
          method: "POST",
          body: { approved },
        },
      );
      if (!alive.current) return;
      if (result.status === "approved")
        patch(id, { sending: undefined, confirming: false, awaitingExecution: true });
      else setItems((prev) => prev?.filter((i) => i.approval.id !== id) ?? prev);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiProblemError && err.status === 403) {
        setCanDecide(false);
        patch(id, { sending: undefined, confirming: false, error: NO_PERMISSION });
      } else if (err instanceof ApiProblemError && (err.status === 409 || err.status === 404)) {
        // O item some na recarga, então o aviso fica no painel (não no item).
        patch(id, { sending: undefined, confirming: false });
        setConflict(
          err.status === 409
            ? "Esta solicitação já foi decidida ou venceu."
            : "Solicitação não encontrada.",
        );
        void load();
      } else {
        patch(id, { sending: undefined, confirming: false, error: describeApiError(err) });
      }
    } finally {
      inFlight.current.delete(id);
    }
  }

  return (
    <section className={ui.panel} aria-labelledby={titleId}>
      <div className={ui.panelHeader}>
        <h2 id={titleId}>Aprovações pendentes</h2>
        <button type="button" className={ui.button} onClick={() => void load()}>
          Atualizar
        </button>
      </div>

      {!canDecide ? (
        <div role="alert" className={ui.alert}>
          {NO_PERMISSION}{" "}
          <button
            type="button"
            className={ui.button}
            onClick={() => {
              setCanDecide(true);
              void load();
            }}
          >
            Tentar de novo
          </button>
        </div>
      ) : null}
      {conflict ? (
        <div role="alert" className={ui.alert}>
          {conflict}
        </div>
      ) : null}
      {loadError ? (
        <div role="alert" className={ui.alert}>
          {loadError}
        </div>
      ) : null}
      <div role="status" aria-live="polite">
        {notices.map((n, i) => (
          <p key={`${i}-${n}`} className={ui.notice}>
            {n}
          </p>
        ))}
      </div>

      {items === null ? <p className={ui.muted}>Carregando…</p> : null}
      {items?.length === 0 && !loadError ? (
        <p className={ui.muted}>Nenhuma aprovação pendente.</p>
      ) : null}

      <ul className={ui.list}>
        {items?.map((item) => {
          const { approval } = item;
          const irreversible = approval.risk === "irreversible";
          const locked =
            item.sending !== undefined || item.awaitingExecution === true || !canDecide;
          return (
            <li
              key={approval.id}
              className={`${styles.item} ${irreversible ? styles.irreversible : ""}`}
              aria-label={`Aprovação ${approval.action}`}
            >
              <div className={styles.head}>
                <strong className={ui.plain}>{approval.action}</strong>
                <span>{formatBrl(approval.valueBrl)}</span>
              </div>
              <p className={ui.muted}>
                Agente {approval.agent} · {irreversible ? "ação irreversível" : approval.risk} ·
                vence em {formatDateTime(approval.expiresAt)}
              </p>
              <pre className={styles.payload} aria-label="Dados da ação">
                {payloadText(approval.payload)}
              </pre>
              {item.error && item.error !== NO_PERMISSION ? (
                <div role="alert" className={ui.alert}>
                  {item.error}
                </div>
              ) : null}
              {item.awaitingExecution ? (
                <p role="status">Aprovada: aguardando a execução…</p>
              ) : (
                <>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={`${ui.button} ${ui.primary}`}
                      disabled={locked || item.confirming === true}
                      onClick={() =>
                        irreversible
                          ? patch(approval.id, { confirming: true })
                          : void decide(approval, true)
                      }
                    >
                      Aprovar
                    </button>
                    <button
                      type="button"
                      className={`${ui.button} ${ui.danger}`}
                      disabled={locked}
                      onClick={() => void decide(approval, false)}
                    >
                      Rejeitar
                    </button>
                  </div>
                  {item.confirming ? (
                    <div className={styles.confirm}>
                      <p className={ui.plain}>
                        Confirmar a aprovação de <strong>{approval.action}</strong> no valor de{" "}
                        {formatBrl(approval.valueBrl)}? Não dá para desfazer.
                      </p>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={`${ui.button} ${ui.primary}`}
                          disabled={locked}
                          onClick={() => void decide(approval, true)}
                        >
                          Confirmar aprovação
                        </button>
                        <button
                          type="button"
                          className={ui.button}
                          disabled={locked}
                          onClick={() => patch(approval.id, { confirming: false })}
                        >
                          Voltar
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
