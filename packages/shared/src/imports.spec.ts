import { describe, expect, it } from "vitest";
import {
  CsvMappingSchema,
  ImportFailureCodeSchema,
  ImportJobListSchema,
  ImportJobViewSchema,
  ImportOptionsSchema,
  ImportUploadFieldsSchema,
} from "./imports.js";

const mapping = {
  date: "Data",
  amount: "Valor",
  description: "Descrição",
  dateFormat: "dd/MM/yyyy",
  decimal: "comma",
};
const csv = { format: "csv", institution: "Nubank", account: "Conta" };
const ok = (v: unknown) => ImportOptionsSchema.safeParse(v).success;

describe("ImportOptionsSchema", () => {
  it("aceita cada formato válido", () => {
    expect(ok({ format: "ofx" })).toBe(true);
    expect(ok({ ...csv, csvPreset: "nubank_conta" })).toBe(true);
    expect(ok({ ...csv, csvMapping: mapping })).toBe(true);
    expect(ok({ ...csv, csvMapping: { ...mapping, delimiter: ";", kind: "Tipo" } })).toBe(true);
    expect(ok({ format: "b3_xlsx" })).toBe(true);
    expect(ok({ format: "b3_xlsx", asOf: "2026-02-28" })).toBe(true);
  });
  it("recusa CSV com preset e mapeamento, ou com nenhum", () => {
    expect(ok({ ...csv, csvPreset: "generico_br", csvMapping: mapping })).toBe(false);
    expect(ok(csv)).toBe(false);
  });
  it("recusa CSV sem account ou sem institution", () => {
    expect(ok({ format: "csv", institution: "Nubank", csvPreset: "nubank_conta" })).toBe(false);
    expect(ok({ format: "csv", account: "Conta", csvPreset: "nubank_conta" })).toBe(false);
  });
  it("recusa institution/account vazios, longos ou com caractere \\p{C}", () => {
    const base = { ...csv, csvPreset: "nubank_conta" };
    expect(ok({ ...base, institution: "Nu‮bank" })).toBe(false);
    expect(ok({ ...base, account: "Co\nnta" })).toBe(false);
    expect(ok({ ...base, institution: "" })).toBe(false);
    expect(ok({ ...base, institution: "x".repeat(81) })).toBe(false);
    expect(ok({ ...base, institution: "x".repeat(80) })).toBe(true);
  });
  it("recusa asOf inexistente ou mal formado", () => {
    expect(ok({ format: "b3_xlsx", asOf: "2026-02-30" })).toBe(false);
    expect(ok({ format: "b3_xlsx", asOf: "28/02/2026" })).toBe(false);
  });
  it("recusa campo extra e formato desconhecido", () => {
    expect(ok({ format: "ofx", extra: 1 })).toBe(false);
    expect(ok({ format: "b3_xlsx", institution: "XP" })).toBe(false);
    expect(ok({ format: "pdf" })).toBe(false);
  });
});

describe("CsvMappingSchema", () => {
  it("recusa decimal 'auto', dateFormat desconhecido, coluna vazia/longa e campo extra", () => {
    const p = (v: unknown) => CsvMappingSchema.safeParse(v).success;
    expect(p(mapping)).toBe(true);
    expect(p({ ...mapping, decimal: "auto" })).toBe(false);
    expect(p({ ...mapping, dateFormat: "MM/dd/yyyy" })).toBe(false);
    expect(p({ ...mapping, date: "" })).toBe(false);
    expect(p({ ...mapping, date: "x".repeat(121) })).toBe(false);
    expect(p({ ...mapping, delimiter: "\t" })).toBe(false);
    expect(p({ ...mapping, extra: "x" })).toBe(false);
  });
});

describe("ImportUploadFieldsSchema", () => {
  it("aceita os campos como texto e recusa extras", () => {
    const p = (v: unknown) => ImportUploadFieldsSchema.safeParse(v).success;
    expect(p({})).toBe(true);
    expect(p({ format: "csv", institution: "x", account: "y", csvMapping: "{}" })).toBe(true);
    expect(p({ format: "pdf" })).toBe(false);
    expect(p({ extra: "x" })).toBe(false);
  });
});

describe("ImportJobViewSchema", () => {
  const job = {
    id: "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a0b1c3d",
    format: "ofx",
    fileName: "extrato.ofx",
    status: "done",
    failureCode: null,
    stats: { rowsRead: 3, positions: 0, transactions: 3, errorRows: 0, ignored: { x: 1 } },
    errors: [],
    createdAt: "2026-11-16T10:00:00.000Z",
    updatedAt: "2026-11-16T10:00:01.000Z",
  };
  const err = { row: 1, code: "invalid_date", message: "Data inválida." };
  const p = (v: unknown) => ImportJobViewSchema.safeParse(v).success;

  it("aceita um job válido e erros com field opcional", () => {
    expect(p(job)).toBe(true);
    expect(p({ ...job, status: "failed", failureCode: "unreadable" })).toBe(true);
    expect(p({ ...job, errors: [err, { ...err, field: "date" }] })).toBe(true);
  });
  it("recusa mais de 100 erros", () => {
    expect(p({ ...job, errors: Array.from({ length: 100 }, () => err) })).toBe(true);
    expect(p({ ...job, errors: Array.from({ length: 101 }, () => err) })).toBe(false);
  });
  it("recusa status e failureCode desconhecidos", () => {
    expect(p({ ...job, status: "x" })).toBe(false);
    expect(p({ ...job, failureCode: "nope" })).toBe(false);
    expect(ImportFailureCodeSchema.safeParse("stuck").success).toBe(true);
  });
  it("lista com cursor", () => {
    expect(ImportJobListSchema.safeParse({ items: [job], nextCursor: null }).success).toBe(true);
    expect(ImportJobListSchema.safeParse({ items: [job] }).success).toBe(false);
  });
});
