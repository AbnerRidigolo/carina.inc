import { describe, expect, it } from "vitest";
import { inspectText } from "./inspect-text.js";

/**
 * `inspectText` roda de forma síncrona, no caminho da requisição, sobre texto influenciado por
 * LLM/usuário: um padrão com tempo quadrático (ReDoS) trava o event loop de toda a API. Estes
 * testes alimentam blobs adversariais de 1 MB; tempo linear leva dezenas de ms, e o orçamento de
 * 500 ms por texto dá folga de uma ordem de grandeza para CI lento. Um padrão quadrático leva
 * segundos a minutos nestes mesmos blobs (medido: "a.".repeat(40_000) = 80 KB levava ~4 s).
 */
const MB = 1024 * 1024;
const BUDGET_MS = 500;

/** Repete `unit` até ter pelo menos 1 MB (em unidades UTF-16). */
const blob = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length));

const BLOBS: readonly (readonly [name: string, text: string])[] = [
  ['"a." (pontos)', blob("a.")],
  ['"a-" (hífens)', blob("a-")],
  ['"a@" (arrobas)', blob("a@")],
  ['"1." (dígitos e pontos)', blob("1.")],
  ['"a.@" (pontos antes do @)', blob("a.@")],
  ['"@a." (domínio sem fim)', blob("@a.")],
  ['"a@b." (quase e-mail)', blob("a@b.")],
  ['"a@b-" (rótulo longo)', blob("a@b-")],
  ['"." (só pontos)', blob(".")],
  ['"a" (só letras)', blob("a")],
  ['" " (só espaços)', blob(" ")],
  ['"ç" (letra acentuada)', blob("ç")],
  ['"123.456.789-0" (CPF incompleto)', blob("123.456.789-0")],
  ['"projeç " (gatilho sem marcador)', blob("projeç ")],
  ['"compre " (recomendação incompleta)', blob("compre ")],
  ['"sem " (certeza incompleta)', blob("sem ")],
  ['"x" * 1 MB + "@" + "a." (um só @ no fim)', `${blob("x")}@${blob("a.")}`],
  ["mistura", blob("a.b-c@d.e 1.2.3 ç. -+ @ ")],
];

describe("inspectText: tempo linear em entradas adversariais de 1 MB", () => {
  it.each(BLOBS)("%s", (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(MB);
    const start = performance.now();
    inspectText(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("PII depois de um bloco grande continua detectada (nenhum truncamento do texto)", () => {
    const codes = (t: string) => inspectText(t).map((f) => f.code);
    expect(codes(`${blob("a.")} contato joao@exemplo.com`)).toContain("lgpd.pii_leak.email");
    expect(codes(`${blob("ç ")} CPF 123.456.789-01`)).toContain("lgpd.pii_leak.cpf");
    expect(codes(`${blob("a@")} fim joao@exemplo.com`)).toContain("lgpd.pii_leak.email");
  });
});
