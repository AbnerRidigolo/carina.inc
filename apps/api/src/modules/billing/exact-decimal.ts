import { Prisma } from "../../generated/prisma/client.js";

/**
 * Decimal com precisão que cobre o produto exato das contas de dinheiro. O `Prisma.Decimal`
 * arredonda cada operação para 20 dígitos significativos: quantidade (até 10 inteiros e 8 casas) ×
 * preço (até 12 inteiros e 6 casas) chega a 36 dígitos, e valor (16 inteiros e 2 casas) × taxa de
 * várias casas passa de 20. Com 20, um produto como 9999999900.00499999995 viraria ...00.0050000000
 * e o meio para cima subiria um centavo. Com 64 a conta é exata e só a regra das 2 casas arredonda.
 * Quem devolve um valor para fora converte de volta para `Prisma.Decimal` (o tipo do resto do código).
 */
export const ExactDecimal = Prisma.Decimal.clone({
  precision: 64,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
});
