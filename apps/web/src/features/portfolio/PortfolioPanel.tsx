import { type NormalizedPosition, NormalizedPositionSchema } from "@carina/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { apiFetch, isAbortError } from "../../api/client";
import { describeApiError } from "../../api/errors";
import ui from "../../styles/ui.module.css";
import { formatBrl, sumMoney } from "../../util/format";
import styles from "./PortfolioPanel.module.css";

const PositionsPageSchema = z.object({
  positions: z.array(NormalizedPositionSchema),
  nextCursor: z.string().nullable(),
});
const PAGE_LIMIT = 100;

const CLASS_ORDER = ["acao", "fii", "tesouro", "renda_fixa", "fundo", "caixa"] as const;
const CLASS_LABELS: Record<(typeof CLASS_ORDER)[number], string> = {
  acao: "Ações",
  fii: "Fundos imobiliários",
  tesouro: "Tesouro Direto",
  renda_fixa: "Renda fixa",
  fundo: "Fundos",
  caixa: "Caixa",
};

/** Posições do cliente agrupadas por classe de ativo; páginas por cursor ("Ver mais"). */
export function PortfolioPanel({ clientId }: { clientId: string }) {
  const [positions, setPositions] = useState<NormalizedPosition[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const titleId = useId();
  const ctrl = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (after: string | null) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      const query = `limit=${PAGE_LIMIT}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      try {
        const page = await apiFetch(
          `/api/clients/${encodeURIComponent(clientId)}/positions?${query}`,
          PositionsPageSchema,
          { signal: c.signal },
        );
        if (c.signal.aborted) return;
        setError(undefined);
        setCursor(page.nextCursor);
        // Paginação por cursor (keyset): junta sem duplicar pelo externalId.
        setPositions((prev) => {
          const map = new Map((after ? (prev ?? []) : []).map((p) => [p.externalId, p]));
          for (const p of page.positions) map.set(p.externalId, p);
          return [...map.values()];
        });
      } catch (err) {
        if (c.signal.aborted || isAbortError(err)) return;
        setError(`Não foi possível carregar a carteira. ${describeApiError(err)}`);
        setPositions((prev) => prev ?? []);
      } finally {
        if (!c.signal.aborted) setLoadingMore(false);
      }
    },
    [clientId],
  );

  useEffect(() => {
    void fetchPage(null);
    return () => ctrl.current?.abort();
  }, [fetchPage]);

  const groups = CLASS_ORDER.map((cls) => ({
    cls,
    rows: (positions ?? []).filter((p) => p.assetClass === cls),
  })).filter((g) => g.rows.length > 0);

  return (
    <section className={ui.panel} aria-labelledby={titleId}>
      <div className={ui.panelHeader}>
        <h2 id={titleId}>Carteira</h2>
      </div>
      {error ? (
        <div role="alert" className={ui.alert}>
          {error}
        </div>
      ) : null}
      {positions === null && !error ? <p className={ui.muted}>Carregando…</p> : null}
      {positions?.length === 0 && !error ? (
        <p className={ui.muted}>Sem posições para este cliente.</p>
      ) : null}

      {positions && positions.length > 0 ? (
        <p className={ui.muted}>
          Total {cursor ? "das posições carregadas" : "da carteira"}:{" "}
          <strong>{formatBrl(sumMoney(positions.map((p) => p.valueBrl)))}</strong>
        </p>
      ) : null}

      {groups.map(({ cls, rows }) => (
        <section key={cls} className={styles.group} aria-label={CLASS_LABELS[cls]}>
          <div className={styles.groupHead}>
            <h3>{CLASS_LABELS[cls]}</h3>
            <strong>{formatBrl(sumMoney(rows.map((r) => r.valueBrl)))}</strong>
          </div>
          <div className={ui.tableWrap}>
            <table className={ui.table} aria-label={`Posições: ${CLASS_LABELS[cls]}`}>
              <thead>
                <tr>
                  <th scope="col">Ativo</th>
                  <th scope="col">Código</th>
                  <th scope="col">Instituição</th>
                  <th scope="col" className={ui.num}>
                    Valor
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.externalId}>
                    <th scope="row">{p.name}</th>
                    <td>{p.assetCode ?? "—"}</td>
                    <td>{p.institution}</td>
                    <td className={ui.num}>{formatBrl(p.valueBrl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {cursor ? (
        <button
          type="button"
          className={ui.button}
          disabled={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void fetchPage(cursor);
          }}
        >
          {loadingMore ? "Carregando…" : "Ver mais"}
        </button>
      ) : null}
    </section>
  );
}
