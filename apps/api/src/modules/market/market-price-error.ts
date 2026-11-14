export type MarketPriceErrorCode = "price_unavailable" | "price_stale" | "unknown_asset";

const MESSAGES: Readonly<Record<MarketPriceErrorCode, string>> = {
  price_unavailable: "Cotação indisponível",
  price_stale: "Cotação antiga demais",
  unknown_asset: "Ativo desconhecido",
};

/**
 * Falha do preço de servidor (`MarketService.priceFor`). Não é um erro HTTP: quem executa a ordem
 * converte o código em recusa (falha fechada). A mensagem é fixa e nunca carrega o erro do provedor.
 */
export class MarketPriceError extends Error {
  override readonly name = "MarketPriceError";

  constructor(readonly code: MarketPriceErrorCode) {
    super(MESSAGES[code]);
  }
}
