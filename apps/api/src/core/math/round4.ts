/**
 * `round(x, 4)` do Python: arredonda a 4 casas, com empate exato (representável em binário, como
 * 0.03125) indo para o par, como o `round` do Python. Fora de empates exatos, `toFixed` (que usa o
 * valor exato do double) dá o mesmo resultado do Python.
 */
export function round4(x: number): number {
  const fixed = x.toFixed(4);
  const exact = x.toFixed(40);
  const dot = exact.indexOf(".");
  const tail = exact.slice(dot + 1 + 4);
  if (/^50*$/.test(tail)) {
    // Empate exato: toFixed arredondou para longe de zero; escolhe o par.
    const down = exact.slice(0, dot + 1 + 4);
    const lastDigit = Number(down.at(-1));
    return Number(lastDigit % 2 === 0 ? down : fixed);
  }
  return Number(fixed);
}
