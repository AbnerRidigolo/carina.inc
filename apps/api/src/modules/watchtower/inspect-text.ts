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
 * `\w` dentro de classe (`[\w.+-]`) não pode virar `[\p{L}\p{N}_]` aninhado; o conteúdo da classe
 * recebe `\p{L}\p{N}_` direto.
 */
function pyClass(source: string): RegExp {
  return py(source.replaceAll(String.raw`[\w`, String.raw`[\p{L}\p{N}_`));
}

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
  ["email", pyClass(String.raw`\b[\w.+-]+@[\w-]+\.[\w.]+\b`)],
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
