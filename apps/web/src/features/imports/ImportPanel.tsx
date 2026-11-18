import type {
  CsvPreset,
  ImportFailureCode,
  ImportJobView,
  ImportUploadFields,
} from "@carina/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiProblemError, isAbortError, listImports, uploadImport } from "../../api/client";
import { describeApiError } from "../../api/errors";
import type { SignalBus } from "../../state/event-bus";
import ui from "../../styles/ui.module.css";
import styles from "./ImportPanel.module.css";

type FormatChoice = "auto" | "ofx" | "csv" | "b3_xlsx";

const FORMATS: { value: FormatChoice; label: string }[] = [
  { value: "auto", label: "automático" },
  { value: "ofx", label: "OFX" },
  { value: "csv", label: "CSV" },
  { value: "b3_xlsx", label: "B3" },
];

const PRESETS: CsvPreset[] = ["nubank_conta", "generico_br"];
/** Instituição que cada preset já determina. */
const PRESET_INSTITUTION: Partial<Record<CsvPreset, string>> = { nubank_conta: "Nubank" };

const MAX_LISTED = 10;
const MAX_ERRORS_SHOWN = 10;

const FAILURE_MESSAGES: Record<ImportFailureCode, string> = {
  unreadable: "não foi possível ler o arquivo; confira o formato e envie de novo",
  no_valid_rows: "nenhuma linha válida no arquivo",
  limit_exceeded: "o arquivo passa dos limites de tamanho ou de linhas",
  unsupported_ofx_investment: "OFX de investimentos não é aceito; use o arquivo da B3",
  missing_as_of: "faltou a data da posição; informe-a e envie de novo",
  expired: "o arquivo expirou antes de ser processado; envie de novo",
  stuck: "o processamento travou; envie o arquivo de novo",
  internal: "erro interno ao processar; tente de novo em instantes",
};

/**
 * Formato provável pela extensão, só para o modo automático decidir quais campos mostrar e mandar
 * (CSV precisa de preset, instituição e conta; B3 com posição precisa de `asOf`). Quem decide o
 * formato de verdade é a API, pelo conteúdo.
 */
function guessFormat(file: File | null): FormatChoice {
  const name = file?.name.toLowerCase() ?? "";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".xlsx")) return "b3_xlsx";
  return "auto";
}

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function percent(processed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((processed * 100) / total)));
}

function describeUploadError(err: unknown): string {
  if (err instanceof ApiProblemError && err.detail && [413, 422, 429].includes(err.status))
    return err.detail;
  return describeApiError(err);
}

function statusLabel(job: ImportJobView, progress: number | undefined): string {
  switch (job.status) {
    case "queued":
      // Já chegou progresso: o worker pegou o job, mesmo que a lista ainda diga "na fila".
      return progress === undefined ? "na fila" : `processando ${progress}%`;
    case "parsing":
      return `processando ${progress ?? 0}%`;
    case "done":
      return "concluído";
    case "failed":
      return `falhou: ${job.failureCode ? FAILURE_MESSAGES[job.failureCode] : "erro desconhecido"}`;
  }
}

function countsLabel(job: ImportJobView): string | undefined {
  if (job.status !== "done") return undefined;
  const { transactions, positions, errorRows } = job.stats;
  const parts: string[] = [];
  if (transactions > 0) parts.push(`${transactions} transações`);
  if (positions > 0) parts.push(`${positions} posições`);
  if (errorRows > 0) parts.push(`${errorRows} linhas com erro`);
  return parts.length > 0 ? parts.join(", ") : "nada importado";
}

interface Props {
  clientId: string;
  bus: SignalBus;
}

/** Envio de arquivos (OFX, CSV, B3) e acompanhamento dos últimos jobs de importação. */
export function ImportPanel({ clientId, bus }: Props) {
  const [jobs, setJobs] = useState<ImportJobView[] | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState<string | undefined>();
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<FormatChoice>("auto");
  const [preset, setPreset] = useState<CsvPreset | "">("");
  const [institution, setInstitution] = useState("");
  const [account, setAccount] = useState("conta");
  const [asOf, setAsOf] = useState(todayIso);
  const fieldsFor = format === "auto" ? guessFormat(file) : format;
  const titleId = useId();
  const ids = {
    file: useId(),
    preset: useId(),
    institution: useId(),
    account: useId(),
    asOf: useId(),
  };
  const loadCtrl = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const sendLock = useRef(false);

  const load = useCallback(async () => {
    loadCtrl.current?.abort();
    const ctrl = new AbortController();
    loadCtrl.current = ctrl;
    try {
      const list = await listImports(clientId, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setLoadError(undefined);
      setJobs(list.items.slice(0, MAX_LISTED));
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err)) return;
      setLoadError(`Não foi possível carregar as importações. ${describeApiError(err)}`);
      setJobs((prev) => prev ?? []);
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

  useEffect(
    () =>
      bus.subscribe((signal) => {
        if (signal.type === "socket_open") {
          void load();
        } else if (signal.type === "import_progress") {
          const value = percent(signal.processed, signal.total);
          setProgress((prev) => ({ ...prev, [signal.importJobId]: value }));
        } else if (signal.type === "import_finished") {
          setProgress((prev) => {
            return Object.fromEntries(
              Object.entries(prev).filter(([id]) => id !== signal.importJobId),
            );
          });
          void load();
        }
      }),
    [bus, load],
  );

  function onPreset(value: string) {
    const next = value as CsvPreset | "";
    setPreset(next);
    const fixed = next === "" ? undefined : PRESET_INSTITUTION[next];
    if (fixed !== undefined) setInstitution(fixed);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setUploadError(undefined);
    const fields: ImportUploadFields = {};
    if (format !== "auto") fields.format = format;
    if (fieldsFor === "csv") {
      if (preset) fields.csvPreset = preset;
      fields.institution = institution;
      fields.account = account;
    }
    if (fieldsFor === "b3_xlsx") fields.asOf = asOf;
    try {
      await uploadImport(clientId, file, fields);
      if (!alive.current) return;
      await load();
    } catch (err) {
      if (alive.current) setUploadError(describeUploadError(err));
    } finally {
      sendLock.current = false;
      if (alive.current) setSending(false);
    }
  }

  return (
    <section className={ui.panel} aria-labelledby={titleId}>
      <div className={ui.panelHeader}>
        <h2 id={titleId}>Importar arquivo</h2>
      </div>

      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <div className={ui.field}>
          <label htmlFor={ids.file}>Arquivo</label>
          <input
            id={ids.file}
            type="file"
            accept=".ofx,.csv,.xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        <fieldset className={styles.formats}>
          <legend>Formato</legend>
          {FORMATS.map((f) => (
            <label key={f.value}>
              <input
                type="radio"
                name={`format-${ids.file}`}
                value={f.value}
                checked={format === f.value}
                onChange={() => setFormat(f.value)}
              />
              {f.label}
            </label>
          ))}
        </fieldset>

        {fieldsFor === "csv" ? (
          <div className={styles.row}>
            <div className={ui.field}>
              <label htmlFor={ids.preset}>Preset do CSV</label>
              <select
                id={ids.preset}
                value={preset}
                onChange={(e) => onPreset(e.target.value)}
                required
              >
                <option value="">escolha…</option>
                {PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className={ui.field}>
              <label htmlFor={ids.institution}>Instituição</label>
              <input
                id={ids.institution}
                value={institution}
                maxLength={80}
                required
                onChange={(e) => setInstitution(e.target.value)}
              />
            </div>
            <div className={ui.field}>
              <label htmlFor={ids.account}>Conta</label>
              <input
                id={ids.account}
                value={account}
                maxLength={80}
                required
                onChange={(e) => setAccount(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        {fieldsFor === "b3_xlsx" ? (
          <div className={ui.field}>
            <label htmlFor={ids.asOf}>Data da posição</label>
            <input
              id={ids.asOf}
              type="date"
              value={asOf}
              required
              onChange={(e) => setAsOf(e.target.value)}
            />
          </div>
        ) : null}

        <div>
          <button
            type="submit"
            className={`${ui.button} ${ui.primary}`}
            disabled={!file || sending}
          >
            {sending ? "Enviando…" : "Importar"}
          </button>
        </div>
      </form>

      {uploadError ? (
        <div role="alert" className={ui.alert}>
          {uploadError}
        </div>
      ) : null}
      {loadError ? (
        <div role="alert" className={ui.alert}>
          {loadError}
        </div>
      ) : null}
      {jobs === null && !loadError ? <p className={ui.muted}>Carregando…</p> : null}
      {jobs?.length === 0 && !loadError ? (
        <p className={ui.muted}>Nenhum arquivo importado ainda.</p>
      ) : null}

      {jobs && jobs.length > 0 ? (
        <ul className={ui.list} aria-label="Últimas importações">
          {jobs.map((job) => {
            const counts = countsLabel(job);
            return (
              <li key={job.id} className={styles.job}>
                <div className={styles.jobHead}>
                  <strong className={styles.fileName}>{job.fileName}</strong>
                  <span>{statusLabel(job, progress[job.id])}</span>
                </div>
                {counts ? <div className={ui.muted}>{counts}</div> : null}
                {job.errors.length > 0 ? (
                  <ul className={styles.errors}>
                    {job.errors.slice(0, MAX_ERRORS_SHOWN).map((err, i) => (
                      <li key={`${err.row}-${i}`}>
                        linha {err.row}: {err.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
