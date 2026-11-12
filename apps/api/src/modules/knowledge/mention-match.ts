/**
 * Casamento de menções (nome de entidade citado num chunk) e ordem canônica de entidades.
 *
 * - `foldText`: NFD, sem marcas combinantes, minúsculas (acentos e caixa não importam).
 * - `citesName`: o nome aparece INTEIRO no texto, com fronteira de palavra Unicode nas pontas:
 *   letras (`\p{L}`), dígitos (`\p{N}`) e marcas (`\p{M}`) são caracteres de palavra. "XP" casa em
 *   "na XP:" mas não em "expectativa", "XPML11" ou "XP3". A fronteira só é exigida na ponta do nome
 *   que é caractere de palavra ("R$" casa em "R$10"; "110% CDI" casa em "de 110% CDI.").
 * - `compareEntityKeys`: ordem por `(type, name)` em pontos de código, a mesma do `COLLATE "C"` do
 *   Postgres (bytes UTF-8), sem depender da collation do banco nem do locale do processo.
 */

export const foldText = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const WORD = /[\p{L}\p{N}\p{M}]/u;

/** Ponto de código que termina antes de `index` (trata par substituto). */
function charBefore(s: string, index: number): string {
  if (index <= 0) return "";
  const low = s.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = s.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(index - 2, index);
  }
  return s.charAt(index - 1);
}

function charAt(s: string, index: number): string {
  const cp = s.codePointAt(index);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

const isWord = (ch: string): boolean => ch !== "" && WORD.test(ch);

/** `hay` e `needle` já dobrados com `foldText`. */
export function citesName(hay: string, needle: string): boolean {
  if (!needle) return false;
  const needStart = isWord(charAt(needle, 0));
  const needEnd = isWord(charBefore(needle, needle.length));
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const end = i + needle.length;
    const startOk = !needStart || !isWord(charBefore(hay, i));
    const endOk = !needEnd || !isWord(charAt(hay, end));
    if (startOk && endOk) return true;
    from = i + 1;
  }
}

/** Comparação por pontos de código (igual a `COLLATE "C"` sobre UTF-8). */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export function compareEntityKeys(
  a: { type: string; name: string },
  b: { type: string; name: string },
): number {
  return compareCodePoints(a.type, b.type) || compareCodePoints(a.name, b.name);
}
