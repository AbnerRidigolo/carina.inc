import { describe, expect, it } from "vitest";
import type { ComplianceFlag } from "@carina/shared";
import { inspectText } from "./inspect-text.js";

/**
 * Corpus de paridade com o Python 3.13 (legacy/python/carina/b2b/watchtower.py::inspect_text).
 * As saídas esperadas foram geradas rodando o Python sobre estas 50 strings (texto -> flags com
 * code, severity e detail); os testes não precisam do Python.
 */
const CORPUS: readonly (readonly [text: string, expected: ComplianceFlag[]])[] = [
  [
    "Esse fundo tem retorno garantido de 2% ao mês.",
    [{ code: "suitability.certainty_claim", severity: "violation", detail: "retorno garantido" }],
  ],
  [
    "Recomendo comprar PETR4 hoje.",
    [
      {
        code: "cvm.unauthorized_recommendation",
        severity: "violation",
        detail: "Recomendo comprar",
      },
    ],
  ],
  [
    "Você deve vender suas ações.",
    [
      {
        code: "cvm.unauthorized_recommendation",
        severity: "violation",
        detail: "Você deve vender",
      },
    ],
  ],
  [
    "O titular é o CPF 123.456.789-01, contato joao@exemplo.com.",
    [
      {
        code: "lgpd.pii_leak.cpf",
        severity: "violation",
        detail: "padrão de cpf detectado na resposta",
      },
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "A projeção de fluxo de caixa indica saldo positivo em 12 meses.",
    [
      {
        code: "suitability.missing_disclaimer",
        severity: "warning",
        detail: "resposta com projeção/tributação sem disclaimer",
      },
    ],
  ],
  ["Seu portfólio está alinhado aos seus objetivos.", []],
  [
    "Compre já",
    [{ code: "cvm.unauthorized_recommendation", severity: "violation", detail: "Compre já" }],
  ],
  [
    "Compre já!",
    [{ code: "cvm.unauthorized_recommendation", severity: "violation", detail: "Compre já" }],
  ],
  [
    "compre já, por favor",
    [{ code: "cvm.unauthorized_recommendation", severity: "violation", detail: "compre já" }],
  ],
  [
    "VENDA JÁ",
    [{ code: "cvm.unauthorized_recommendation", severity: "violation", detail: "VENDA JÁ" }],
  ],
  ["compre jáfoi", []],
  ["é123.456.789-01", []],
  ["ção123.456.789-01", []],
  ["123.456.789-01ção", []],
  ["CPF 12345678901", []],
  ["n1234.456.789-012", []],
  [
    "(123.456.789-01)",
    [
      {
        code: "lgpd.pii_leak.cpf",
        severity: "violation",
        detail: "padrão de cpf detectado na resposta",
      },
    ],
  ],
  [
    "joão@exemplo.com",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "Escreva para joao@exemplo.com.",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "ana.souza+x@banco-teste.com.br",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "..a@x.com",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [".@x.com", []],
  ["a@.com", []],
  ["a@b.", []],
  ["a@b..", []],
  [
    "a@b.c.",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "a@b-.c",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "a@-b.c",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "a@b.c-",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  ["@x.com", []],
  ["x@y", []],
  [
    "a@b@c.com",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "foo@bar.com.br.",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "foo@bar..com",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  ["foo@bar.-", []],
  [
    "foo@bar.é",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "ação@é.com",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "user_name@sub_domain.exemplo.org",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "mail me: x@y.zz!",
    [
      {
        code: "lgpd.pii_leak.email",
        severity: "violation",
        detail: "padrão de email detectado na resposta",
      },
    ],
  ],
  [
    "Lucro garantido no trimestre",
    [{ code: "suitability.certainty_claim", severity: "violation", detail: "Lucro garantido" }],
  ],
  [
    "Com certeza vai subir amanhã",
    [
      {
        code: "suitability.certainty_claim",
        severity: "violation",
        detail: "Com certeza vai subir",
      },
    ],
  ],
  [
    "Investimento sem nenhum risco, risco zero",
    [{ code: "suitability.certainty_claim", severity: "violation", detail: "sem nenhum risco" }],
  ],
  [
    "VOCÊ DEVE COMPRAR",
    [
      {
        code: "cvm.unauthorized_recommendation",
        severity: "violation",
        detail: "VOCÊ DEVE COMPRAR",
      },
    ],
  ],
  [
    "PROJEÇÃO sem nada",
    [
      {
        code: "suitability.missing_disclaimer",
        severity: "warning",
        detail: "resposta com projeção/tributação sem disclaimer",
      },
    ],
  ],
  ["NÃO É RECOMENDAÇÃO. Projeção.", []],
  ["Projeção. Consulte seu contador.", []],
  ["Cenário base com imposto de renda; resultados passados não garantem", []],
  [
    "CPF ١٢٣.٤٥٦.٧٨٩-٠١",
    [
      {
        code: "lgpd.pii_leak.cpf",
        severity: "violation",
        detail: "padrão de cpf detectado na resposta",
      },
    ],
  ],
  [
    "Recomendo que você compre agora, venda imediatamente, ganho certo",
    [
      { code: "suitability.certainty_claim", severity: "violation", detail: "ganho certo" },
      {
        code: "cvm.unauthorized_recommendation",
        severity: "violation",
        detail: "Recomendo que você compre",
      },
    ],
  ],
  [
    "K recomendo comprar",
    [
      {
        code: "cvm.unauthorized_recommendation",
        severity: "violation",
        detail: "recomendo comprar",
      },
    ],
  ],
];

describe("inspectText: paridade com o Python 3.13 (corpus fixo de 50 strings)", () => {
  it("o corpus tem 50 entradas", () => {
    expect(CORPUS).toHaveLength(50);
  });

  it.each(CORPUS.map(([text, expected], i) => [i, text, expected] as const))(
    "#%i %j",
    (_i, text, expected) => {
      expect(inspectText(text)).toEqual(expected);
    },
  );
});
