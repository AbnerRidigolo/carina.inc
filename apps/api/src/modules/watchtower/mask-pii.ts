/**
 * Mascaramento de PII na pergunta antes de ela entrar na trilha de auditoria (`audit_event.query`,
 * append-only e visível para qualquer chave `chat` do tenant em `GET /api/audit`).
 *
 * Troca cada ocorrência por um marcador do tipo (`[cpf]`, `[cnpj]`, `[email]`, `[cartao]`,
 * `[telefone]`) e depois trunca em `MAX_AUDIT_QUERY_CHARS` code points. É uma defesa por padrões
 * conhecidos, não uma garantia: nome, endereço ou PII em formato livre continuam passando.
 *
 * Todas as regex são lineares: quantificadores limitados ou delimitados por caracteres fora da
 * classe (o e-mail reaproveita o padrão linear do Watchtower), e fronteiras de dígito por
 * lookaround para não cortar números maiores ao meio.
 */
import { EMAIL_PATTERN } from "./inspect-text.js";

export const MAX_AUDIT_QUERY_CHARS = 500;

const D = String.raw`\p{Nd}`;
const NOT_DIGIT_BEFORE = String.raw`(?<!\p{Nd})`;
const NOT_DIGIT_AFTER = String.raw`(?!\p{Nd})`;
const bounded = (body: string) => new RegExp(`${NOT_DIGIT_BEFORE}${body}${NOT_DIGIT_AFTER}`, "gu");

/** Ordem importa: do padrão mais específico para o mais genérico. */
const MASKS: readonly (readonly [marker: string, pattern: RegExp])[] = [
  // O padrão do Watchtower só confirma o domínio até o 1º caractere depois do ponto; para mascarar,
  // consome o resto do domínio (classe sem nada depois: sem backtracking).
  ["[email]", new RegExp(`${EMAIL_PATTERN.source}[\\p{L}\\p{N}_.-]*`, "gu")],
  // 12.345.678/0001-95 ou 14 dígitos seguidos.
  ["[cnpj]", bounded(String.raw`${D}{2}\.?${D}{3}\.?${D}{3}/?${D}{4}-?${D}{2}`)],
  // 123.456.789-09 ou 11 dígitos seguidos.
  ["[cpf]", bounded(String.raw`${D}{3}\.?${D}{3}\.?${D}{3}-?${D}{2}`)],
  // (11) 98765-4321, 11 98765-4321, +55 11 987654321… (antes do cartão: com DDI são 13 dígitos)
  [
    "[telefone]",
    bounded(String.raw`(?:\+?55[ -]?)?(?:\(${D}{2}\)|${D}{2})[ -]?9?${D}{4}[ -]?${D}{4}`),
  ],
  // 13 a 19 dígitos, com espaço ou hífen opcional entre eles.
  ["[cartao]", bounded(String.raw`(?:${D}[ -]?){12,18}${D}`)],
];

export function maskPii(text: string): string {
  let out = text;
  for (const [marker, pattern] of MASKS) out = out.replace(pattern, marker);
  return out;
}

/** Pergunta como vai para a auditoria: PII mascarada e no máximo MAX_AUDIT_QUERY_CHARS. */
export function auditQuery(query: string): string {
  const masked = maskPii(query);
  const chars = Array.from(masked);
  return chars.length <= MAX_AUDIT_QUERY_CHARS
    ? masked
    : chars.slice(0, MAX_AUDIT_QUERY_CHARS).join("");
}
