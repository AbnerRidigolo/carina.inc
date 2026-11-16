import { z } from "zod";

export const ImportFormatSchema = z.enum(["ofx", "csv", "b3_xlsx"]);
export type ImportFormat = z.infer<typeof ImportFormatSchema>;

export const ImportStatusSchema = z.enum(["queued", "parsing", "done", "failed"]);
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

/** Etapa reportada nos eventos de progresso (stream e WebSocket). */
export const ImportProgressStageSchema = z.enum(["parsing", "writing"]);
export type ImportProgressStage = z.infer<typeof ImportProgressStageSchema>;

/** Desfecho reportado nos eventos de término (stream e WebSocket). */
export const ImportFinishedStatusSchema = z.enum(["done", "failed"]);
export type ImportFinishedStatus = z.infer<typeof ImportFinishedStatusSchema>;

/** Nome de coluna do CSV: 1 a 120 caracteres. */
const ColumnNameSchema = z.string().min(1).max(120);

/** Texto livre curto (instituição, conta): 1 a 80 caracteres, sem nenhum `\p{C}` do Unicode. */
const ShortLabelSchema = z
  .string()
  .regex(
    /^[^\p{C}]{1,80}$/u,
    "precisa ter de 1 a 80 caracteres, sem caracteres de controle, de formatação ou inválidos",
  );

/** Mapeamento explícito das colunas do CSV: nada é inferido (decimal e data vêm daqui). */
export const CsvMappingSchema = z
  .object({
    date: ColumnNameSchema,
    amount: ColumnNameSchema,
    description: ColumnNameSchema,
    kind: ColumnNameSchema.optional(),
    category: ColumnNameSchema.optional(),
    externalId: ColumnNameSchema.optional(),
    dateFormat: z.enum(["dd/MM/yyyy", "yyyy-MM-dd"]),
    decimal: z.enum(["comma", "dot"]),
    delimiter: z.enum([";", ","]).optional(),
  })
  .strict();
export type CsvMapping = z.infer<typeof CsvMappingSchema>;

export const CsvPresetSchema = z.enum(["nubank_conta", "generico_br"]);
export type CsvPreset = z.infer<typeof CsvPresetSchema>;

const OfxOptionsSchema = z.object({ format: z.literal("ofx") }).strict();

const CsvOptionsSchema = z
  .object({
    format: z.literal("csv"),
    institution: ShortLabelSchema,
    account: ShortLabelSchema,
    csvPreset: CsvPresetSchema.optional(),
    csvMapping: CsvMappingSchema.optional(),
  })
  .strict()
  .refine((o) => (o.csvPreset === undefined) !== (o.csvMapping === undefined), {
    message: "informe exatamente um entre csvPreset e csvMapping",
    path: ["csvPreset"],
  });

const B3XlsxOptionsSchema = z
  .object({ format: z.literal("b3_xlsx"), asOf: z.iso.date().optional() })
  .strict();

/** Opções da importação, por formato. */
export const ImportOptionsSchema = z.union([
  OfxOptionsSchema,
  CsvOptionsSchema,
  B3XlsxOptionsSchema,
]);
export type ImportOptions = z.infer<typeof ImportOptionsSchema>;

/**
 * Campos multipart do upload, ainda como texto (`csvMapping` é JSON em texto); o controller valida
 * isto e só então monta `ImportOptions`.
 */
export const ImportUploadFieldsSchema = z
  .object({
    format: ImportFormatSchema.optional(),
    institution: z.string().optional(),
    account: z.string().optional(),
    csvPreset: z.string().optional(),
    csvMapping: z.string().optional(),
    asOf: z.string().optional(),
  })
  .strict();
export type ImportUploadFields = z.infer<typeof ImportUploadFieldsSchema>;

/** Erro de linha: sem conteúdo do arquivo, `message` fixa por `code`. */
export const ImportRowErrorSchema = z.object({
  row: z.number().int().nonnegative(),
  field: z.string().optional(),
  code: z.string(),
  message: z.string(),
});
export type ImportRowError = z.infer<typeof ImportRowErrorSchema>;

export const ImportStatsSchema = z.object({
  rowsRead: z.number().int().nonnegative(),
  positions: z.number().int().nonnegative(),
  transactions: z.number().int().nonnegative(),
  errorRows: z.number().int().nonnegative(),
  ignored: z.record(z.string(), z.number().int().nonnegative()),
});
export type ImportStats = z.infer<typeof ImportStatsSchema>;

export const ImportFailureCodeSchema = z.enum([
  "unreadable",
  "no_valid_rows",
  "limit_exceeded",
  "unsupported_ofx_investment",
  "missing_as_of",
  "expired",
  "stuck",
  "internal",
]);
export type ImportFailureCode = z.infer<typeof ImportFailureCodeSchema>;

export const MAX_IMPORT_ERRORS = 100;

export const ImportJobViewSchema = z.object({
  id: z.uuid(),
  format: ImportFormatSchema,
  fileName: z.string(),
  status: ImportStatusSchema,
  failureCode: ImportFailureCodeSchema.nullable(),
  stats: ImportStatsSchema,
  errors: z.array(ImportRowErrorSchema).max(MAX_IMPORT_ERRORS),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ImportJobView = z.infer<typeof ImportJobViewSchema>;

export const ImportJobListSchema = z.object({
  items: z.array(ImportJobViewSchema),
  nextCursor: z.string().nullable(),
});
export type ImportJobList = z.infer<typeof ImportJobListSchema>;
