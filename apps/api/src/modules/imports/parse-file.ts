/**
 * Parse de um arquivo importado FORA do event loop do worker: o parser é trabalho síncrono de CPU
 * (uma planilha honesta de 49 MB descompactada leva segundos; uma hostil, mais), então roda numa
 * `worker_threads` Worker, uma por arquivo, encerrada à força (`terminate`) ao estourar
 * PARSE_LIMITS.parseTimeoutMs (30 s) → `failure: "limit_exceeded"`. Um timer cooperativo na
 * mesma thread não serviria: ele só dispara depois que o parser devolve o controle. A heap da
 * thread é limitada a `maxHeapMb` (env IMPORT_PARSE_MAX_HEAP_MB; padrão PARSE_LIMITS.maxThreadHeapMb,
 * 512 MB) por duas travas, e estourar qualquer uma vira `limit_exceeded`, sem derrubar o processo:
 *   1. `resourceLimits.maxOldGenerationSizeMb`: o V8 mata a thread (`ERR_WORKER_OUT_OF_MEMORY`).
 *      ATENÇÃO: uma flag de heap do PROCESSO (`--max-old-space-size`, `--max-heap-size`, inclusive
 *      via NODE_OPTIONS) vale para todos os isolates e ANULA essa opção em silêncio: a thread passa
 *      a ter o limite do processo (comportamento documentado do Node, nodejs/node#43992, em
 *      qualquer versão). Ver `heapFlagOverride`.
 *   2. Vigia (`worker.getHeapStatistics()` a cada `heapCheckMs`, padrão 50 ms; responde mesmo
 *      com a thread presa em CPU): heap usada acima de `maxHeapMb` → `terminate()`. Independe de
 *      flags; pode deixar a heap passar do limite pelo que a thread alocar entre duas leituras.
 *
 * - Os bytes são TRANSFERIDOS para a thread (sem cópia de até 10 MB): o `Uint8Array` do chamador
 *   fica destacado (vazio) depois da chamada. Se ele for uma vista parcial de um buffer maior, só
 *   a parte dele é copiada antes, para não destacar memória alheia.
 * - O `signal` (parada do worker) encerra a thread e rejeita com ParseAbortedError.
 * - Erro dentro da thread → ParseThreadError com só o NOME do erro (LGPD: a mensagem poderia
 *   carregar conteúdo do arquivo).
 * - Em código-fonte (testes com vitest, `import.meta.url` termina em `.ts`), a thread carrega o
 *   `parse-thread.ts` com o type stripping do Node, a condição `source` dos pacotes do workspace
 *   e um hook que resolve os imports `./x.js` para `./x.ts`. No build (`dist`), carrega o `.js`.
 */
import { Worker } from "node:worker_threads";
import type { ImportFormat, ImportOptions } from "@carina/shared";
import type { ParsedFile } from "./parse-dispatch.js";
import { PARSE_LIMITS } from "./parsers/types.js";

export type { ParsedFile } from "./parse-dispatch.js";

/** Mensagem de entrada da thread (`workerData`). */
export interface ParseRequest {
  format: ImportFormat;
  bytes: Uint8Array;
  options: ImportOptions;
}

type ThreadReply = { ok: true; result: ParsedFile } | { ok: false; error: string };

/** Onde está a entrada da thread (substituível nos testes). */
export interface ParseThreadSpec {
  filename: string | URL;
  /** `filename` é o código da thread (CommonJS), não um caminho. */
  eval?: boolean;
  execArgv?: string[];
}

export interface ParseFileOptions {
  /** Padrão: PARSE_LIMITS.parseTimeoutMs. */
  timeoutMs?: number;
  /** Padrão: PARSE_LIMITS.maxThreadHeapMb. */
  maxHeapMb?: number;
  /** Intervalo do vigia de heap. Padrão: PARSE_LIMITS.heapCheckMs. */
  heapCheckMs?: number;
  /**
   * Só testes: `false` não passa `resourceLimits` à thread, para provar o vigia sozinho (como
   * quando uma flag do processo anula a trava do V8). Padrão: true.
   */
  v8HeapLimit?: boolean;
  thread?: ParseThreadSpec;
}

export class ParseAbortedError extends Error {
  constructor() {
    super("Parse interrompido: o worker está parando");
    this.name = "ParseAbortedError";
  }
}

export class ParseThreadError extends Error {
  constructor(reason: string) {
    super(`A thread do parse falhou (${reason})`);
    this.name = "ParseThreadError";
  }
}

/** Resolve `./x.js` → `./x.ts` quando o `.js` não existe (só no modo código-fonte). */
const TS_RESOLVE_HOOKS = `export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && specifier.endsWith(".js")) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    throw err;
  }
}`;
const REGISTER_TS_RESOLVE = `import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(TS_RESOLVE_HOOKS)}`)});`;

function defaultThread(): ParseThreadSpec {
  if (!import.meta.url.endsWith(".ts")) {
    // execArgv explícito: a thread não herda as flags do processo (ex.: `--env-file-if-exists`).
    return { filename: new URL("./parse-thread.js", import.meta.url), execArgv: [] };
  }
  return {
    filename: new URL("./parse-thread.ts", import.meta.url),
    execArgv: [
      "--conditions=source",
      "--disable-warning=ExperimentalWarning",
      "--import",
      `data:text/javascript,${encodeURIComponent(REGISTER_TS_RESOLVE)}`,
    ],
  };
}

const HEAP_FLAG = /^--max[-_](old[-_]space|heap)[-_]size(=|$)/;

/**
 * A flag de heap do processo que anula `resourceLimits.maxOldGenerationSizeMb` das threads, se
 * houver (na linha de comando ou em NODE_OPTIONS). Com ela, só o vigia limita a heap do parse.
 */
export function heapFlagOverride(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS,
): string | undefined {
  const args = [...execArgv, ...(nodeOptions ?? "").split(/\s+/)];
  return args.find((a) => HEAP_FLAG.test(a));
}

function limitExceeded(): ParsedFile {
  return {
    positions: [],
    transactions: [],
    errors: [],
    stats: { rowsRead: 0, positions: 0, transactions: 0, errorRows: 0, ignored: {} },
    failure: "limit_exceeded",
  };
}

/** Bytes próprios, transferíveis: a mesma memória quando o array cobre o buffer inteiro. */
function transferable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const whole =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength;
  return whole ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

export function parseFile(
  format: ImportFormat,
  bytes: Uint8Array,
  options: ImportOptions,
  signal: AbortSignal,
  opts: ParseFileOptions = {},
): Promise<ParsedFile> {
  if (signal.aborted) return Promise.reject(new ParseAbortedError());
  const spec = opts.thread ?? defaultThread();
  const timeoutMs = opts.timeoutMs ?? PARSE_LIMITS.parseTimeoutMs;
  const maxHeapMb = opts.maxHeapMb ?? PARSE_LIMITS.maxThreadHeapMb;
  const heapCheckMs = opts.heapCheckMs ?? PARSE_LIMITS.heapCheckMs;
  const own = transferable(bytes);
  const request: ParseRequest = { format, bytes: own, options };

  return new Promise<ParsedFile>((resolve, reject) => {
    const thread = new Worker(spec.filename, {
      workerData: request,
      transferList: [own.buffer],
      ...(opts.v8HeapLimit === false
        ? {}
        : { resourceLimits: { maxOldGenerationSizeMb: maxHeapMb } }),
      ...(spec.eval === true ? { eval: true } : {}),
      ...(spec.execArgv ? { execArgv: spec.execArgv } : {}),
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(heapTimer);
      signal.removeEventListener("abort", onAbort);
      fn();
      // Sem esperar: terminate de uma thread que já respondeu é imediato; de uma presa em CPU,
      // interrompe a execução dela.
      void thread.terminate().catch(() => undefined);
    };
    const onAbort = () => {
      settle(() => reject(new ParseAbortedError()));
    };
    const timer = setTimeout(() => {
      settle(() => resolve(limitExceeded()));
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });

    // Vigia de heap: uma leitura por vez; rejeição (thread já saiu) só encerra o vigia.
    const maxHeapBytes = maxHeapMb * 1024 * 1024;
    let heapTimer: NodeJS.Timeout | undefined;
    const watchHeap = () => {
      heapTimer = setTimeout(() => {
        thread.getHeapStatistics().then(
          (s) => {
            if (settled) return;
            if (s.used_heap_size > maxHeapBytes) settle(() => resolve(limitExceeded()));
            else watchHeap();
          },
          () => undefined,
        );
      }, heapCheckMs);
    };
    thread.once("online", watchHeap);

    thread.once("message", (reply: ThreadReply) => {
      settle(() => {
        if (reply.ok) resolve(reply.result);
        else reject(new ParseThreadError(reply.error));
      });
    });
    thread.once("error", (err: unknown) => {
      // Estourar a heap é limite do arquivo, como o tempo: limit_exceeded, não erro interno.
      if ((err as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY") {
        settle(() => resolve(limitExceeded()));
        return;
      }
      settle(() => reject(new ParseThreadError(err instanceof Error ? err.name : "Error")));
    });
    thread.once("exit", (code: number) => {
      settle(() => reject(new ParseThreadError(`saída ${code.toString()}`)));
    });
  });
}
