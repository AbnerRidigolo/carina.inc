import { MAX_IMPORT_ERRORS } from "@carina/shared";
import type {
  ImportFailureCode,
  ImportRowError,
  ImportStats,
  NormalizedPosition,
  NormalizedTransaction,
} from "@carina/shared";

/** Resultado de um parser. Com `failure`, o arquivo inteiro falhou e as listas vêm vazias. */
export interface ParseResult {
  positions: NormalizedPosition[];
  transactions: NormalizedTransaction[];
  errors: ImportRowError[];
  stats: ImportStats;
  failure?: ImportFailureCode;
}

/** Lançada quando o arquivo estoura algum limite de `PARSE_LIMITS`. */
export class ImportLimitError extends Error {
  readonly code = "limit_exceeded" as const;

  constructor(message = "Limite de importação excedido.") {
    super(message);
    this.name = "ImportLimitError";
  }
}

export const PARSE_LIMITS = {
  maxRows: 100_000,
  maxColumns: 64,
  maxLineBytes: 65_536,
  maxUnzippedBytes: 52_428_800,
  maxZipEntries: 50,
  maxPositions: 1000,
  maxStoredErrors: MAX_IMPORT_ERRORS,
  parseTimeoutMs: 30_000,
  /** Heap (old generation) da worker thread do parse; estourar → `limit_exceeded`. */
  maxThreadHeapMb: 512,
} as const;
