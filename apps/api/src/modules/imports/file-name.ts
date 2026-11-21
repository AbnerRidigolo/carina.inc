import { MAX_IMPORT_FILE_NAME } from "@carina/shared";

const FALLBACK = "arquivo";

/**
 * Nome de exibição do arquivo enviado: só o nome-base (depois do último `/` ou `\`), em NFC, sem
 * nenhum caractere `\p{C}` (controle, formatação como o override RTL, não atribuídos), sem espaços
 * nas pontas e com no máximo 120 caracteres. Vazio vira "arquivo". Serve só para exibição.
 */
export function sanitizeFileName(raw: string | undefined): string {
  const name = raw ?? "";
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const clean = base.normalize("NFC").replace(/\p{C}/gu, "").trim();
  const cut = Array.from(clean).slice(0, MAX_IMPORT_FILE_NAME).join("").trim();
  return cut === "" ? FALLBACK : cut;
}
