/**
 * Relógio injetável: devolve o instante atual em ms desde a época. Os limites (e depois a
 * reconciliação) leem a hora por aqui, e os testes o substituem para avançar o tempo.
 */
export type Clock = () => number;

export const CLOCK = Symbol("CLOCK");
