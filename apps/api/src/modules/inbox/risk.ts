/**
 * Classificação de risco das ações do agente executor (spec §6.2).
 *
 * Listas EXPLÍCITAS de ações de leitura e reversíveis; qualquer outra ação, inclusive nome
 * desconhecido, vazio ou com outra caixa, é IRREVERSÍVEL e passa pela aprovação humana. (O Python
 * liberava ações desconhecidas.) A comparação é exata, sem normalização: `GET_POSITIONS` não é
 * `get_positions`.
 */
import type { RiskClass } from "@carina/shared";

export const READ_ACTIONS: ReadonlySet<string> = new Set([
  "get_positions",
  "get_transactions",
  "analyze_portfolio",
]);

/**
 * Só ações com executor registrado (ExecutorRegistry): uma ação reversível executa sem aprovação.
 * `update_goal` e `schedule_report` saíram da lista enquanto não têm executor; até lá são
 * irreversíveis (pedem aprovação) pelo padrão.
 */
export const REVERSIBLE_ACTIONS: ReadonlySet<string> = new Set(["create_alert"]);

export function classifyRisk(action: string): RiskClass {
  if (READ_ACTIONS.has(action)) return "read";
  if (REVERSIBLE_ACTIONS.has(action)) return "reversible";
  return "irreversible";
}
