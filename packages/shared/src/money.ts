import { z } from "zod";

/** Valor monetário em BRL: sempre string decimal com no máximo 2 casas, nunca `number`. */
export const MoneySchema = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/);
export type Money = z.infer<typeof MoneySchema>;

/** Quantidade de ativo: string decimal com até 8 casas. */
export const QuantitySchema = z.string().regex(/^-?\d{1,16}(\.\d{1,8})?$/);
export type Quantity = z.infer<typeof QuantitySchema>;
