import { type ImportRowError, MAX_IMPORT_ERRORS } from "@carina/shared";

export type RowErrorCode =
  | "invalid_date"
  | "ambiguous_amount"
  | "invalid_amount"
  | "missing_field"
  | "invalid_quantity"
  | "unknown_kind"
  | "formula_without_value"
  | "stale_snapshot"
  | "too_many_positions"
  | "schema";

/** Mensagens fixas por código: nunca carregam conteúdo do arquivo (LGPD). */
export const ROW_ERROR_MESSAGES: Record<RowErrorCode, string> = {
  invalid_date: "Data inválida ou em formato diferente do mapeado.",
  ambiguous_amount: "Valor ambíguo: não foi possível determinar o separador decimal.",
  invalid_amount: "Valor numérico inválido.",
  missing_field: "Campo obrigatório ausente.",
  invalid_quantity: "Quantidade inválida.",
  unknown_kind: "Tipo de operação desconhecido.",
  formula_without_value: "Célula com fórmula sem valor calculado.",
  stale_snapshot: "Posição mais antiga que uma já registrada para o ativo.",
  too_many_positions: "Arquivo excede o limite de posições por importação.",
  schema: "Linha não atende ao formato esperado.",
};

/** Acumula erros de linha: guarda só os primeiros 100, mas conta todos. */
export class RowErrors {
  private readonly stored: ImportRowError[] = [];
  private total = 0;

  add(row: number, code: RowErrorCode, field?: string): void {
    this.total += 1;
    if (this.stored.length >= MAX_IMPORT_ERRORS) return;
    this.stored.push({
      row,
      ...(field === undefined ? {} : { field }),
      code,
      message: ROW_ERROR_MESSAGES[code],
    });
  }

  list(): ImportRowError[] {
    return [...this.stored];
  }

  count(): number {
    return this.total;
  }
}
