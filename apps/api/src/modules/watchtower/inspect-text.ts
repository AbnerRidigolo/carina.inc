/**
 * Checagens de compliance determinísticas sobre o texto de resposta de um agente.
 *
 * Port literal de `legacy/python/carina/b2b/watchtower.py` (mesmas regras, códigos, severidades e
 * detalhes). As regex ficam idênticas, com as adaptações abaixo para o JS reproduzir a semântica
 * do `re` do Python 3 sobre `str` (Unicode):
 * - flag `u` + `i`: case-insensitive Unicode (`VOCÊ`/`você`, `PROJEÇÃO`/`projeç`);
 * - `\b` do Python considera letras acentuadas como caractere de palavra ("já", "ção"); o `\b` do
 *   JS é só ASCII (não há fronteira entre "á" e um espaço). Por isso `\b` vira `WB` (abaixo);
 * - `\w` vira `[\p{L}\p{N}_]` e `\d` vira `\p{Nd}` (no Python ambos são Unicode).
 *
 * A PII nunca entra na flag: só o tipo detectado. Certeza e recomendação carregam apenas o trecho
 * mínimo que as disparou.
 */
import type { ComplianceFlag } from "@carina/shared";

const WORD = String.raw`[\p{L}\p{N}_]`;
/** Equivalente ao `\b` do Python 3 (str): fronteira entre caractere de palavra Unicode e não-palavra. */
const WB = String.raw`(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

/** Compila com `iu`; `\b`, `\w` e `\d` são escritos como no Python e traduzidos aqui. */
function py(source: string): RegExp {
  const translated = source
    .replaceAll(String.raw`\b`, WB)
    .replaceAll(String.raw`\w`, WORD)
    .replaceAll(String.raw`\d`, String.raw`\p{Nd}`);
  return new RegExp(translated, "iu");
}

/**
 * E-mail: equivalente EXATO, em tempo linear, de `\b[\w.+-]+@[\w-]+\.[\w.]+\b` (Python).
 *
 * O padrão original é quadrático: cada fronteira de palavra inicia uma varredura O(n) de
 * `[\w.+-]+` que nunca encontra `@` (blobs como "a.a.a." de 80 KB levavam ~4 s e travavam o event
 * loop). A forma abaixo foi derivada do original, sem truncar o texto nem limitar tamanhos:
 *
 * - Parte local: `[\w.+-]+` entre uma fronteira `\b` e o `@`. Os caracteres que não são `\w` da
 *   classe são só `.`, `+` e `-`. Existe um início com `\b` dentro da sequência maximal da classe
 *   se e somente se ela contém algum caractere `\w` (o primeiro `\w` da sequência é precedido por
 *   fim de sequência ou por `.+-`, ou seja, por não-palavra). Logo: a sequência maximal à esquerda
 *   do `@` precisa conter um `\w`: `(?<!C)[.+-]*\w C*@`, com `C = [\w.+-]`. O lookbehind
 *   `(?<!C)` faz a busca só começar no início de cada sequência maximal (custo O(1) nas demais
 *   posições), e sequências à esquerda de `@`s distintos são disjuntas, então o total é O(n).
 * - Domínio: `[\w-]+` seguido de `.` só casa se o rótulo for a sequência maximal de `[\w-]` (o
 *   caractere seguinte a um prefixo seria da própria classe, nunca `.`). Depois do `.`, `[\w.]+\b`
 *   casa se e somente se a sequência maximal de `[\w.]` contém um `\w` (o último `\w` dela tem
 *   fronteira à direita): `\.\.*\w`. Cada varredura termina no próximo caractere fora da classe,
 *   e `@` está fora das classes, então as varreduras de `@`s distintos também são disjuntas.
 *
 * Sem backtracking aninhado: cada quantificador é seguido de um delimitador que não pertence à
 * sua classe. Não há divergência de comportamento em relação ao Python (parte local de qualquer
 * tamanho continua sendo detectada).
 */
export const EMAIL_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.+-])[.+-]*[\p{L}\p{N}_][\p{L}\p{N}_.+-]*@[\p{L}\p{N}_-]+\.\.*[\p{L}\p{N}_]`,
  "u",
);

/** Afirmações de certeza em projeções financeiras (violação de suitability). */
const CERTAINTY_PATTERNS: readonly RegExp[] = [
  String.raw`retorno garantido`,
  String.raw`lucro garantido`,
  String.raw`ganho (?:certo|garantido)`,
  String.raw`com certeza vai (?:subir|cair|valorizar|render)`,
  String.raw`vai subir com certeza`,
  String.raw`sem (?:nenhum )?risco`,
  String.raw`risco zero`,
].map(py);

/** Recomendação direta de compra/venda (conflito com a regulação CVM de consultores). */
const RECOMMENDATION_PATTERNS: readonly RegExp[] = [
  String.raw`\brecomendo (?:que você )?(?:comprar|vender|compre|venda)\b`,
  String.raw`\bvocê deve (?:comprar|vender)\b`,
  String.raw`\bcompre (?:agora|já|imediatamente)\b`,
  String.raw`\bvenda (?:agora|já|imediatamente)\b`,
].map(py);

/** PII estruturada que nunca deve aparecer em resposta (LGPD). */
const PII_PATTERNS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ["cpf", py(String.raw`\b\d{3}\.\d{3}\.\d{3}-\d{2}\b`)],
  ["email", EMAIL_PATTERN],
];

/** Termos que exigem disclaimer quando presentes na resposta. */
const DISCLAIMER_TRIGGERS = py(String.raw`projeç|cenário|previs|imposto|tributá|fluxo de caixa`);
const DISCLAIMER_MARKERS = py(
  String.raw`não (?:é|constitui) (?:uma )?recomendaç|estimativa|premissas|` +
    String.raw`consulte (?:um|seu) (?:assessor|contador|especialista)|resultados passados`,
);

/** Roda todas as checagens sobre `text`. Devolve `[]` quando o texto está limpo. */
export function inspectText(text: string): ComplianceFlag[] {
  const flags: ComplianceFlag[] = [];

  for (const pattern of CERTAINTY_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      flags.push({ code: "suitability.certainty_claim", severity: "violation", detail: m[0] });
      break;
    }
  }

  for (const pattern of RECOMMENDATION_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      flags.push({
        code: "cvm.unauthorized_recommendation",
        severity: "violation",
        detail: m[0],
      });
      break;
    }
  }

  for (const [kind, pattern] of PII_PATTERNS) {
    if (pattern.test(text)) {
      // Nunca incluir o valor da PII na flag: apenas o tipo detectado.
      flags.push({
        code: `lgpd.pii_leak.${kind}`,
        severity: "violation",
        detail: `padrão de ${kind} detectado na resposta`,
      });
    }
  }

  if (DISCLAIMER_TRIGGERS.test(text) && !DISCLAIMER_MARKERS.test(text)) {
    flags.push({
      code: "suitability.missing_disclaimer",
      severity: "warning",
      detail: "resposta com projeção/tributação sem disclaimer",
    });
  }

  return flags;
}
