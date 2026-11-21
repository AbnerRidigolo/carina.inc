import type { CsvMapping, CsvPreset } from "@carina/shared";

/** Mapeamentos prontos para exportações conhecidas; nada é inferido além do que está aqui. */
export const CSV_PRESETS: Record<CsvPreset, { mapping: CsvMapping; institution?: string }> = {
  nubank_conta: {
    mapping: {
      date: "Data",
      amount: "Valor",
      externalId: "Identificador",
      description: "Descrição",
      dateFormat: "dd/MM/yyyy",
      decimal: "dot",
      delimiter: ",",
    },
    institution: "Nubank",
  },
  generico_br: {
    mapping: {
      date: "Data",
      amount: "Valor",
      description: "Descrição",
      category: "Categoria",
      dateFormat: "dd/MM/yyyy",
      decimal: "comma",
      delimiter: ";",
    },
  },
};
