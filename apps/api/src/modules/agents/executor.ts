/**
 * Executor: converte o pedido do cliente numa `ActionProposal`. NUNCA executa nada: `request` só
 * registra a solicitação na inbox (`InboxService.request`), que classifica o risco (ação
 * desconhecida é IRREVERSÍVEL) e pausa até a aprovação humana; a execução acontece depois, em
 * `InboxService.executeOnce`.
 *
 * A saída do modelo é não confiável: além do schema (`ActionProposalSchema`, com `MoneySchema` em
 * `valueBrl`), checamos nome da ação (1 a 128), valor não negativo e, para `place_trade`, o
 * formato do payload. Falhou: `AllProvidersFailedError` (mensagem fixa, sem eco da saída do
 * modelo), o mesmo contrato das demais saídas ruins do modelo.
 */
import { type ActionProposal, ActionProposalSchema, QuantitySchema } from "@carina/shared";
import { z } from "zod";
import { AllProvidersFailedError } from "../../core/errors/domain-errors.js";
import { Prisma } from "../../generated/prisma/client.js";
import { extractValueBrl, payloadNotionalBrl } from "../billing/pricing.js";
import type { InboxService } from "../inbox/inbox.service.js";
import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentInput, type AgentLogger, LlmAgent } from "./agent.js";
import { checkMoney } from "./output-limits.js";
import { PROMPTS } from "./prompts.js";

export const MAX_ACTION_CHARS = 128;
export const MAX_RATIONALE_CHARS = 2000;
export const MAX_TRADE_QUANTITY = 1_000_000_000;

const PlaceTradePayloadSchema = z
  .object({
    side: z.enum(["buy", "sell"]),
    assetCode: z.string().regex(/^[A-Z]{4}\d{1,2}$/),
    quantity: z.union([
      z.number().positive().max(MAX_TRADE_QUANTITY),
      QuantitySchema.refine((q) => Number(q) > 0 && Number(q) <= MAX_TRADE_QUANTITY),
    ]),
  })
  .passthrough();

const invalid = (): AllProvidersFailedError => new AllProvidersFailedError();

/**
 * Ações que movem dinheiro (as execuções com executor registrado: ordem, transferência e
 * rebalanceamento). Só nelas o `valueBrl` é a base da taxa e vale conferir o payload; em outras
 * ações chaves como `price`/`value` têm outro sentido (ex.: o limite de um `create_alert`).
 */
export const MONEY_MOVING_ACTIONS: ReadonlySet<string> = new Set([
  "place_trade",
  "transfer",
  "rebalance",
]);

/**
 * O `valueBrl` é afirmado pelo modelo e é a base da taxa de execução. Não há fonte de preço no
 * servidor para derivá-lo (fase 2), então ele não é recalculado; mas, quando o próprio payload
 * permite conferir, a proposta incoerente é recusada:
 * - valor explícito no payload (`value_brl`, `valueBrl`, `amount`, `value`, `valor`): tem de ser
 *   igual ao `valueBrl` (em módulo);
 * - quantidade × preço unitário (`unitPriceBrl`, `unit_price_brl`, `priceBrl`, `price`): tem de dar o
 *   `valueBrl` (2 casas, meio para cima); preço presente mas não numérico também é recusado.
 */
function assertValueMatchesPayload(p: ActionProposal): void {
  if (!MONEY_MOVING_ACTIONS.has(p.action.trim())) return;
  const declared = new Prisma.Decimal(p.valueBrl);
  const explicit = extractValueBrl(p.payload);
  if (explicit !== undefined && !explicit.eq(declared)) throw invalid();
  const notional = payloadNotionalBrl(p.payload);
  if (notional === null || (notional !== undefined && !notional.eq(declared))) throw invalid();
}

export function refineProposal(p: ActionProposal): ActionProposal {
  const action = p.action.trim();
  if (action.length === 0 || action.length > MAX_ACTION_CHARS) throw invalid();
  checkMoney(p.valueBrl, { nonNegative: true });
  assertValueMatchesPayload(p);
  if (action === "place_trade" && !PlaceTradePayloadSchema.safeParse(p.payload).success) {
    throw invalid();
  }
  return { ...p, action, rationale: p.rationale.slice(0, MAX_RATIONALE_CHARS) };
}

export class ExecutorAgent extends LlmAgent<ActionProposal> {
  constructor(
    models: ModelFactory,
    logger: AgentLogger,
    private readonly inbox: Pick<InboxService, "request">,
  ) {
    super(models, logger, {
      name: "executor",
      role: "reasoning",
      prompt: PROMPTS.executor,
      schema: ActionProposalSchema,
      refine: refineProposal,
    });
  }

  /** Propõe e envia à inbox (aprovação humana para o que não for leitura/reversível). */
  async request(
    input: AgentInput,
    threadId: string,
    turn = 1,
  ): Promise<{ proposal: ActionProposal; approvalId: string; created: boolean }> {
    const proposal = (await this.run(input)) as ActionProposal;
    const { approvalId, created } = await this.inbox.request({
      threadId,
      turn,
      agent: "executor",
      action: proposal.action,
      payload: proposal.payload,
      valueBrl: proposal.valueBrl,
    });
    return { proposal, approvalId, created };
  }
}
