import { describe, expect, it } from "vitest";
import { MAX_AUDIT_QUERY_CHARS, auditQuery, maskPii } from "./mask-pii.js";

describe("maskPii", () => {
  it.each([
    ["CPF formatado", "meu cpf é 123.456.789-09, ok", "meu cpf é [cpf], ok"],
    ["CPF sem pontuação", "cpf 12345678909 ok", "cpf [cpf] ok"],
    ["CNPJ", "empresa 12.345.678/0001-95", "empresa [cnpj]"],
    ["e-mail", "escreva para joao.silva+x@exemplo.com.br hoje", "escreva para [email] hoje"],
    ["telefone", "liga no (11) 98765-4321", "liga no [telefone]"],
    ["telefone com DDI", "liga +55 11 987654321", "liga [telefone]"],
    ["cartão", "cartão 4111 1111 1111 1111 vence", "cartão [cartao] vence"],
  ])("%s", (_name, input, expected) => {
    expect(maskPii(input)).toBe(expected);
  });

  it("não mexe em valores e tickers comuns", () => {
    const q = "compre 100 ações de PETR4 por R$ 30,00 até 2026-12-01";
    expect(maskPii(q)).toBe(q);
  });

  it("mascara todas as ocorrências", () => {
    expect(maskPii("a@b.co e c@d.co")).toBe("[email] e [email]");
  });

  it("tempo linear em entrada adversarial de 1 MB", () => {
    const blob = "1-".repeat(512 * 1024) + "a.".repeat(256 * 1024);
    const t0 = performance.now();
    maskPii(blob);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("auditQuery", () => {
  it("mascara antes de truncar em MAX_AUDIT_QUERY_CHARS code points", () => {
    const long = `${"x".repeat(MAX_AUDIT_QUERY_CHARS - 3)} 123.456.789-09`;
    const out = auditQuery(long);
    expect(out).not.toMatch(/\d{3}\.\d{3}/);
    expect([...out].length).toBeLessThanOrEqual(MAX_AUDIT_QUERY_CHARS);
    expect([...auditQuery("😀".repeat(600))].length).toBe(MAX_AUDIT_QUERY_CHARS);
  });
});
