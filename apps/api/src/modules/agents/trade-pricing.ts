/**
 * Preço de servidor do `place_trade` (spec 5.5, itens 2 a 4). O valor da ordem, base da taxa de
 * execução, é `quantidade × preço da cotação`, em decimal exato e arredondado para 2 casas (meio
 * para cima); ele substitui o `valueBrl` do modelo.
 *
 * O payload devolvido é montado do zero: só o formato da ordem (`side`, `assetCode`, `quantity`
 * como veio) e os campos do servidor. Nenhuma outra chave do modelo passa, nem as de valor e de
 * preço (`MODEL_VALUE_KEYS` de billing/pricing.ts, em qualquer caixa) nem qualquer outra.
 *
 * Falha fechada: proposta fora do formato, cotação de outro ativo (`quote.symbol` diferente do
 * `assetCode`), preço que não é decimal positivo, notional que não cabe em `numeric(18,2)` (acima
 * de `MAX_MONEY_BRL`) ou que arredonda para zero lançam `MarketPriceError("price_unavailable")`, e
 * nenhuma aprovação é criada.
 */
import { PriceSchema, type Quote } from "@carina/shared";
import { Prisma } from "../../generated/prisma/client.js";
import { MAX_MONEY_BRL } from "../billing/pricing.js";
import { MarketPriceError } from "../market/market-price-error.js";
import { PlaceTradePayloadSchema } from "./executor.js";

/**
 * Decimal com precisão que cobre o produto exato. O `Prisma.Decimal` arredonda cada operação para
 * 20 dígitos significativos, e quantidade (até 10 inteiros e 8 casas) × preço (até 12 inteiros e 6
 * casas) chega a 36: com 20, um produto como 9999999900.00499999995 viraria ...00.0050000000 e o
 * meio para cima subiria um centavo. Com 64 o produto é exato e só a regra das 2 casas arredonda.
 */
const ExactDecimal = Prisma.Decimal.clone({
  precision: 64,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
});
const MAX_NOTIONAL = new ExactDecimal(MAX_MONEY_BRL.toFixed());

const unavailable = (): MarketPriceError => new MarketPriceError("price_unavailable");

export interface PricedTrade {
  /** Payload a gravar na aprovação: o formato da ordem mais os campos do servidor. */
  payload: Record<string, unknown>;
  /** `quantidade × quote.price`, 2 casas (meio para cima); igual a `payload.notionalBrl`. */
  valueBrl: string;
}

export function priceTrade(proposalPayload: Record<string, unknown>, quote: Quote): PricedTrade {
  const parsed = PlaceTradePayloadSchema.safeParse(proposalPayload);
  if (!parsed.success) throw unavailable();
  const { side, assetCode, quantity } = parsed.data;

  // A cotação tem de ser do ativo da ordem: comparação exata, sem normalizar. Cotação de outro
  // ativo (erro de lote, de chave de cache, de normalização) não pode precificar nem cobrar a ordem.
  if (quote.symbol !== assetCode) throw unavailable();

  // O `Quote` é tipado, mas o preço é a base do dinheiro: confere o formato de novo (string decimal,
  // sem sinal nem expoente) e exige positivo.
  if (!PriceSchema.safeParse(quote.price).success) throw unavailable();
  const price = new ExactDecimal(quote.price);
  if (!price.gt(0)) throw unavailable();

  // Quantidade numérica entra por `String`, nunca por aritmética em `number`.
  let qty: Prisma.Decimal;
  try {
    qty = new ExactDecimal(String(quantity));
  } catch {
    throw unavailable();
  }
  if (!qty.isFinite() || !qty.gt(0)) throw unavailable();

  const notional = qty.mul(price).toDecimalPlaces(2, ExactDecimal.ROUND_HALF_UP);
  if (!notional.gt(0) || notional.gt(MAX_NOTIONAL)) throw unavailable();
  const valueBrl = notional.toFixed(2);

  return {
    payload: {
      side,
      assetCode,
      quantity,
      unitPriceBrl: quote.price,
      notionalBrl: valueBrl,
      priceSource: quote.source,
      priceAsOf: quote.updatedAt,
      marketState: quote.marketState,
    },
    valueBrl,
  };
}
