import type { NormalizedPosition, NormalizedTransaction } from "@carina/shared";

/** Origem de um dado do cliente final (coluna `source` de `position` e `transaction`). */
export const SOURCES = ["api", "import", "synthetic"] as const;
export type Source = (typeof SOURCES)[number];

/**
 * Fonte de posições e transações de um cliente final (spec §6.4). Nenhum consumidor vê o formato
 * bruto da fonte: tudo sai normalizado. `clientId` é o id interno (uuid) do cliente.
 * A API de ingestão (`source: "api"`) recebe os dados por push; o gerador sintético e a importação
 * de arquivos implementam esta interface; um agregador pago seria só mais uma implementação.
 */
export interface FinancialDataProvider {
  readonly source: Source;
  positions(input: { clientId: string }): AsyncIterable<NormalizedPosition>;
  transactions(input: { clientId: string }): AsyncIterable<NormalizedTransaction>;
}
