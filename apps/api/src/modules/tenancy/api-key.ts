/**
 * Chaves de API: `sk-live-` + 32 caracteres base62 (crypto.randomBytes).
 *
 * Só o sha256 (hex) da chave é gravado em `api_key.hash`; a chave em texto é mostrada uma única
 * vez, na criação. O `prefix` (12 primeiros caracteres) identifica a chave em telas e logs sem
 * expor o segredo. Nunca registre a chave nem o hash em log.
 */
import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "sk-live-";
const BODY_LENGTH = 32;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// Maior múltiplo de 62 que cabe num byte: bytes >= 248 são descartados (sem viés de módulo).
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

export interface GeneratedApiKey {
  key: string;
  hash: string;
  prefix: string;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= UNBIASED_LIMIT) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBase62(BODY_LENGTH);
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}
