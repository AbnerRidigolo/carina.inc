import { describe, expect, it } from "vitest";
import { inspectText } from "./inspect-text.js";

const codes = (text: string): Set<string> => new Set(inspectText(text).map((f) => f.code));

describe("inspectText (port de legacy/python/tests/test_b2b_watchtower.py)", () => {
  it("afirmação de certeza em projeção é violação", () => {
    const flags = inspectText("Esse fundo tem retorno garantido de 2% ao mês.");
    expect(flags).toContainEqual({
      code: "suitability.certainty_claim",
      severity: "violation",
      detail: "retorno garantido",
    });
  });

  it("recomendação direta de compra é violação", () => {
    expect(codes("Recomendo comprar PETR4 hoje.")).toContain("cvm.unauthorized_recommendation");
    expect(codes("Você deve vender suas ações.")).toContain("cvm.unauthorized_recommendation");
  });

  it("PII (CPF e e-mail) é detectada sem vazar o valor na flag", () => {
    const flags = inspectText("O titular é o CPF 123.456.789-01, contato joao@exemplo.com.");
    const found = new Set(flags.map((f) => f.code));
    expect(found).toContain("lgpd.pii_leak.cpf");
    expect(found).toContain("lgpd.pii_leak.email");
    for (const f of flags) {
      expect(f.severity).toBe("violation");
      expect(f.detail).not.toContain("123.456.789-01");
      expect(f.detail).not.toContain("joao@exemplo.com");
    }
    expect(flags.find((f) => f.code === "lgpd.pii_leak.cpf")?.detail).toBe(
      "padrão de cpf detectado na resposta",
    );
    expect(flags.find((f) => f.code === "lgpd.pii_leak.email")?.detail).toBe(
      "padrão de email detectado na resposta",
    );
  });

  it("projeção sem disclaimer gera warning", () => {
    expect(inspectText("A projeção de fluxo de caixa indica saldo positivo em 12 meses.")).toEqual([
      {
        code: "suitability.missing_disclaimer",
        severity: "warning",
        detail: "resposta com projeção/tributação sem disclaimer",
      },
    ]);
  });

  it("projeção com disclaimer não gera warning", () => {
    const text =
      "A projeção de fluxo de caixa indica saldo positivo em 12 meses. " +
      "Os valores são estimativas baseadas em premissas explícitas e não constituem recomendação.";
    expect(codes(text)).not.toContain("suitability.missing_disclaimer");
  });

  it("texto limpo não gera flags", () => {
    expect(inspectText("Seu portfólio está alinhado aos seus objetivos.")).toEqual([]);
  });
});

describe("inspectText: critérios da Task 10", () => {
  it("CPF: o detail não contém o valor", () => {
    const flags = inspectText("O CPF dele é 123.456.789-09");
    const cpf = flags.find((f) => f.code === "lgpd.pii_leak.cpf");
    expect(cpf).toBeDefined();
    expect(cpf?.detail).not.toContain("123.456");
  });

  it("projeção com 'estimativa com premissas' não gera missing_disclaimer", () => {
    expect(
      codes("Projeção de fluxo de caixa: estimativa com premissas").has(
        "suitability.missing_disclaimer",
      ),
    ).toBe(false);
  });
});

describe("inspectText: regras individuais do Python", () => {
  it.each([
    ["Lucro garantido no trimestre", "Lucro garantido"],
    ["É ganho certo", "ganho certo"],
    ["ganho garantido", "ganho garantido"],
    ["Com certeza vai subir amanhã", "Com certeza vai subir"],
    ["com certeza vai render muito", "com certeza vai render"],
    ["O papel vai subir com certeza", "vai subir com certeza"],
    ["Investimento sem risco algum", "sem risco"],
    ["Investimento sem nenhum risco", "sem nenhum risco"],
    ["Aplicação de RISCO ZERO", "RISCO ZERO"],
  ])("certeza: %s", (text, snippet) => {
    expect(inspectText(text)).toContainEqual({
      code: "suitability.certainty_claim",
      severity: "violation",
      detail: snippet,
    });
  });

  it("só a primeira regra de certeza e a primeira de recomendação disparam (break)", () => {
    const flags = inspectText("Retorno garantido e risco zero. Compre agora. Recomendo vender.");
    expect(flags.filter((f) => f.code === "suitability.certainty_claim")).toHaveLength(1);
    expect(flags.filter((f) => f.code === "cvm.unauthorized_recommendation")).toHaveLength(1);
    // A ordem dos padrões manda: "retorno garantido" vem antes de "risco zero".
    expect(flags[0]?.detail).toBe("Retorno garantido");
  });

  it.each([
    "Recomendo que você comprar ITUB4",
    "recomendo vender tudo",
    "Recomendo compre já",
    "Você deve comprar",
    "COMPRE AGORA!",
    "Compre imediatamente.",
    "Venda agora mesmo",
    "venda imediatamente",
  ])("recomendação: %s", (text) => {
    expect(codes(text)).toContain("cvm.unauthorized_recommendation");
  });

  it("recomendação inclui apenas o trecho que disparou", () => {
    const flags = inspectText("Na minha análise, recomendo que você comprar PETR4 hoje.");
    expect(flags.find((f) => f.code === "cvm.unauthorized_recommendation")?.detail).toBe(
      "recomendo que você comprar",
    );
  });

  it("palavras vizinhas não disparam recomendação (fronteira de palavra)", () => {
    expect(codes("Recomendo compraria só com análise")).not.toContain(
      "cvm.unauthorized_recommendation",
    );
    expect(codes("a recomendo comprarem")).not.toContain("cvm.unauthorized_recommendation");
  });

  it.each([
    "cenário base",
    "previsão do tempo",
    "imposto de renda",
    "carga tributária",
    "fluxo de caixa",
  ])("gatilho de disclaimer: %s", (text) => {
    expect(codes(text)).toContain("suitability.missing_disclaimer");
  });

  it.each([
    "Projeção. Isso não é recomendação.",
    "Projeção. Isso não constitui uma recomendação.",
    "Projeção. Consulte um assessor.",
    "Projeção. Consulte seu contador.",
    "Projeção. Consulte seu especialista.",
    "Projeção. Resultados passados não garantem o futuro.",
    "Projeção com PREMISSAS.",
  ])("marcador de disclaimer: %s", (text) => {
    expect(codes(text)).not.toContain("suitability.missing_disclaimer");
  });

  it("e-mail é detectado em formatos comuns, inclusive com acento (\\w unicode do Python)", () => {
    expect(codes("fale com ana.souza+x@banco-teste.com.br")).toContain("lgpd.pii_leak.email");
    expect(codes("fale com joão@exemplo.com")).toContain("lgpd.pii_leak.email");
    expect(codes("sem arroba aqui")).not.toContain("lgpd.pii_leak.email");
  });

  it("CPF só no formato pontuado e com fronteira de palavra", () => {
    expect(codes("CPF 12345678901")).not.toContain("lgpd.pii_leak.cpf");
    expect(codes("n1234.456.789-012")).not.toContain("lgpd.pii_leak.cpf");
    expect(codes("(123.456.789-01)")).toContain("lgpd.pii_leak.cpf");
  });
});

describe("inspectText: e-mail em tempo linear sem divergência do Python (R12)", () => {
  // O padrão de e-mail foi reescrito para tempo linear SEM limitar tamanhos (ver inspect-text.ts):
  // partes locais e domínios de qualquer comprimento continuam detectados, como no Python, e
  // nenhuma divergência de comportamento foi aceita.
  const email = (t: string) => codes(t).has("lgpd.pii_leak.email");

  it("parte local longa (> 64 caracteres) continua detectada, como no Python", () => {
    expect(email(`${"a".repeat(100)}@exemplo.com`)).toBe(true);
    expect(email(`${"ab.".repeat(100)}cd@exemplo.com`)).toBe(true);
    expect(email(`x ${"a".repeat(5000)}@exemplo.com y`)).toBe(true);
  });

  it("domínio longo (> 255 caracteres) continua detectado", () => {
    expect(email(`a@${"b".repeat(400)}.com`)).toBe(true);
    expect(email(`a@b.${"c.".repeat(300)}com`)).toBe(true);
  });

  it("a flag continua genérica mesmo com PII gigante", () => {
    const value = `${"a".repeat(100)}@exemplo.com`;
    const flag = inspectText(value).find((f) => f.code === "lgpd.pii_leak.email");
    expect(flag).toEqual({
      code: "lgpd.pii_leak.email",
      severity: "violation",
      detail: "padrão de email detectado na resposta",
    });
  });

  it("casos de borda iguais ao Python (verificados contra Python 3.13)", () => {
    const yes = ["..a@x.com", "a@b.c", "joão@exemplo.com", "a@b.c.", "x@y.é"];
    const no = [
      "a@b.-c",
      ".@x.com",
      "-+.@x.com",
      "@x.com",
      "a@.com",
      "a@b.",
      "a@b..",
      "a@b.-",
      "x@y",
      "a@-b",
    ];
    for (const t of yes) expect([t, email(t)]).toEqual([t, true]);
    for (const t of no) expect([t, email(t)]).toEqual([t, false]);
  });

  it("só o primeiro e-mail importa: uma flag por tipo, mesmo com vários e-mails", () => {
    const flags = inspectText("a@b.com c@d.com e@f.com");
    expect(flags.filter((f) => f.code === "lgpd.pii_leak.email")).toHaveLength(1);
  });
});

describe("inspectText: paridade de \\b do Python (str unicode) em português", () => {
  // Em JS, `\b` é só ASCII: depois de uma letra acentuada ("já") não há fronteira antes de espaço
  // ou pontuação. O Python 3 trata 'á' como caractere de palavra.
  it.each(["Compre já", "Compre já!", "compre já, por favor", "Venda já.", "VENDA JÁ"])(
    "'%s' dispara recomendação",
    (text) => {
      expect(codes(text)).toContain("cvm.unauthorized_recommendation");
    },
  );

  it("'já' seguido de letra continua sem fronteira (compre jáfoi)", () => {
    expect(codes("compre jáfoi")).not.toContain("cvm.unauthorized_recommendation");
  });

  it("letra acentuada antes do CPF conta como caractere de palavra (sem fronteira)", () => {
    expect(codes("é123.456.789-01")).not.toContain("lgpd.pii_leak.cpf");
    expect(codes("ção123.456.789-01")).not.toContain("lgpd.pii_leak.cpf");
  });

  it("e-mail com ponto final: a fronteira recua para antes do '.' (como no Python)", () => {
    const flags = inspectText("Escreva para joao@exemplo.com.");
    expect(flags.map((f) => f.code)).toEqual(["lgpd.pii_leak.email"]);
  });

  it("IGNORECASE em texto acentuado", () => {
    expect(codes("VOCÊ DEVE COMPRAR")).toContain("cvm.unauthorized_recommendation");
    expect(codes("PROJEÇÃO sem nada")).toContain("suitability.missing_disclaimer");
    expect(codes("CENÁRIO base")).toContain("suitability.missing_disclaimer");
    expect(codes("NÃO É RECOMENDAÇÃO. Projeção.")).not.toContain("suitability.missing_disclaimer");
  });

  it("\\d do Python é Unicode: dígitos não-ASCII também formam CPF", () => {
    expect(codes("CPF ١٢٣.٤٥٦.٧٨٩-٠١")).toContain("lgpd.pii_leak.cpf");
  });
});
