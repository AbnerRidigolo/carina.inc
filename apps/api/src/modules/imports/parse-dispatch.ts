/**
 * Despacho síncrono do parser pelo formato do job, com as opções guardadas no upload. Roda dentro
 * da worker thread (parse-thread.ts); fica num módulo próprio para a thread carregar só os
 * parsers, e para os testes o chamarem no próprio processo.
 */
import type { ImportFormat, ImportOptions } from "@carina/shared";
import { parseB3 } from "./parsers/b3.js";
import { CSV_PRESETS } from "./parsers/csv-presets.js";
import { parseCsv } from "./parsers/csv.js";
import { parseOfx } from "./parsers/ofx.js";
import type { ParseResult } from "./parsers/types.js";

/** Resultado do parse; `positionInstitutions` só no XLSX da B3. */
export type ParsedFile = ParseResult & { positionInstitutions?: string[] };

export function runParser(
  format: ImportFormat,
  bytes: Uint8Array,
  options: ImportOptions,
): ParsedFile {
  switch (format) {
    case "ofx":
      return parseOfx(bytes);
    case "csv": {
      if (options.format !== "csv") throw new TypeError("Opções não são de CSV");
      const mapping =
        options.csvMapping ??
        (options.csvPreset === undefined ? undefined : CSV_PRESETS[options.csvPreset].mapping);
      if (mapping === undefined) throw new TypeError("CSV sem mapeamento");
      return parseCsv(bytes, {
        mapping,
        institution: options.institution,
        account: options.account,
      });
    }
    case "b3_xlsx": {
      if (options.format !== "b3_xlsx") throw new TypeError("Opções não são da B3");
      return parseB3(bytes, options.asOf === undefined ? {} : { asOf: options.asOf });
    }
  }
}
