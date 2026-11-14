import { describe, expect, it } from "vitest";
import { citesName, compareEntityKeys, foldText } from "./mention-match.js";

const cites = (text: string, name: string) => citesName(foldText(text), foldText(name));

describe("citesName: nome inteiro, com fronteira de palavra Unicode", () => {
  it('"XP" não casa dentro de "expectativa", "XPML11" nem "XP3"', () => {
    expect(cites("A expectativa é de alta.", "XP")).toBe(false);
    expect(cites("Cotas de XPML11 na BTG", "XP")).toBe(false);
    expect(cites("Fundo XP3", "XP")).toBe(false);
  });

  it("casa o nome isolado, com pontuação, início e fim do texto", () => {
    expect(cites("500 PETR4 (ação) na XP: R$ 15.000,00", "XP")).toBe(true);
    expect(cites("XP", "XP")).toBe(true);
    expect(cites("(XP)", "XP")).toBe(true);
    expect(cites("na xp.", "XP")).toBe(true);
    expect(cites("expectativa e depois XP", "XP")).toBe(true);
  });

  it("letras acentuadas e de outros alfabetos contam como letras", () => {
    expect(cites("Itaú Unibanco", "Itaú")).toBe(true);
    expect(cites("Itaúsa", "Itaú")).toBe(false);
    expect(cites("Itaú", "Itau")).toBe(true); // dobra de acentos
    expect(cites("B3é", "B3")).toBe(false);
    expect(cites("日本B3", "B3")).toBe(false);
    expect(cites("negociado na B3.", "B3")).toBe(true);
  });

  it("nomes com espaços e pontuação nas pontas", () => {
    expect(cites("Tesouro Selic 2029 (tesouro) na BTG", "Tesouro Selic 2029")).toBe(true);
    expect(cites("Tesouro Selic 20290", "Tesouro Selic 2029")).toBe(false);
    expect(cites("Taxa de 110% CDI.", "110% CDI")).toBe(true);
    expect(cites("classe renda_fixa:", "renda_fixa")).toBe(true);
    expect(cites("custo de R$ 10", "R$")).toBe(true);
  });

  it("nome vazio nunca casa", () => {
    expect(cites("qualquer texto", "")).toBe(false);
  });
});

describe("compareEntityKeys: (type, name) por ponto de código, sem collation", () => {
  it("ordena por tipo e depois nome", () => {
    const keys = [
      { type: "instituicao", name: "XP" },
      { type: "ativo", name: "b" },
      { type: "ativo", name: "B" },
      { type: "ativo", name: "É" },
      { type: "ativo", name: "😀" },
      { type: "ativo", name: "￿" },
    ];
    expect([...keys].sort(compareEntityKeys)).toEqual([
      { type: "ativo", name: "B" },
      { type: "ativo", name: "b" },
      { type: "ativo", name: "É" },
      { type: "ativo", name: "￿" },
      { type: "ativo", name: "😀" },
      { type: "instituicao", name: "XP" },
    ]);
  });
});
