import { describe, expect, it } from "vitest";
import { fnv1a32, HashEmbeddings, tokenize } from "./hash-embeddings.js";

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("HashEmbeddings", () => {
  const emb = new HashEmbeddings();

  it("embedQuery tem 1024 dimensões e norma 1", async () => {
    const v = await emb.embedQuery("Ações da PETR4");
    expect(v).toHaveLength(1024);
    expect(Math.abs(norm(v) - 1)).toBeLessThan(1e-6);
  });

  it("a ordem dos tokens não importa", async () => {
    const a = await emb.embedQuery("PETR4 petrobras");
    const b = await emb.embedQuery("petrobras PETR4");
    expect(cos(a, b)).toBeGreaterThan(0.99);
  });

  it("textos sem tokens em comum ficam distantes", async () => {
    const a = await emb.embedQuery("PETR4");
    const b = await emb.embedQuery("tesouro selic");
    expect(cos(a, b)).toBeLessThan(0.2);
  });

  it("é determinístico", async () => {
    expect(await emb.embedQuery("Tesouro IPCA+ 2035")).toEqual(
      await new HashEmbeddings().embedQuery("Tesouro IPCA+ 2035"),
    );
  });

  it("acentos e caixa não mudam o vetor", async () => {
    expect(await emb.embedQuery("AÇÕES")).toEqual(await emb.embedQuery("acoes"));
  });

  it("texto sem tokens dá o vetor zero com [0] = 1", async () => {
    const v = await emb.embedQuery("  ?!  ");
    expect(v[0]).toBe(1);
    expect(v.slice(1).every((x) => x === 0)).toBe(true);
  });

  it("embedDocuments embute cada texto como embedQuery", async () => {
    const docs = await emb.embedDocuments(["PETR4", "tesouro selic"]);
    expect(docs).toEqual([await emb.embedQuery("PETR4"), await emb.embedQuery("tesouro selic")]);
  });

  it("tokenize: minúsculas, sem acentos, só letras e números", () => {
    expect(tokenize("Ações da PETR4, R$ 30!")).toEqual(["acoes", "da", "petr4", "r", "30"]);
  });

  it("fnv1a32 segue os vetores de referência (UTF-8)", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });
});
