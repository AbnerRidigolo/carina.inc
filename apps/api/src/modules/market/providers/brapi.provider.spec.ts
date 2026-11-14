import { readFileSync } from "node:fs";
import { HistoricalBarSchema, QuoteSchema } from "@carina/shared";
import { describe, expect, it, vi } from "vitest";
import { MarketDataUnavailableError, ValidationError } from "../../../core/errors/domain-errors.js";
import { BrapiProvider, type BrapiProviderOptions } from "./brapi.provider.js";
import type { MarketLogger } from "./safe-fetch.js";

// Fixtures RECONSTRUÍDAS (não gravadas: o sandbox não alcança brapi.dev) a partir do exemplo da
// especificação OpenAPI oficial (brapi.dev/swagger/latest.json, QuoteTickersResponse e
// HistoricalDataPrice), reduzidas aos campos usados.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const QUOTE_BODY = fixture("brapi-quote.reconstructed.json");
const HISTORY_BODY = fixture("brapi-history.reconstructed.json");

const RawQuoteSchema = QuoteSchema.omit({ marketState: true });
const TOKEN = "tok-segredo-123";
/** Relógio fixo: depois das horas das fixtures (2026-02-08) e das barras (até 2026-02-04). */
const NOW = Date.parse("2026-02-09T12:00:00.000Z");
const SKEW_MS = 2 * 60_000;

function setup(body: string | (() => Response), extra: Partial<BrapiProviderOptions> = {}) {
  const fetchImpl = vi.fn<typeof fetch>(() =>
    Promise.resolve(typeof body === "string" ? new Response(body) : body()),
  );
  const warn = vi.fn<MarketLogger["warn"]>();
  const provider = new BrapiProvider({
    baseUrl: "https://brapi.example/api",
    token: TOKEN,
    timeoutMs: 1000,
    maxBytes: 64 * 1024,
    fetchImpl,
    logger: { warn },
    now: () => NOW,
    ...extra,
  });
  return { provider, fetchImpl, warn };
}

/** 404 que a brapi devolve quando nenhum ticker pedido existe (formato de erro da API). */
const brapiNotFound = () =>
  new Response(JSON.stringify({ error: true, message: "Não encontramos a ação ZZZZ4" }), {
    status: 404,
  });

/** Resposta com um único item de cotação, a partir de um válido com campos trocados. */
function quoteBody(overrides: Record<string, unknown>, drop: string[] = []): string {
  const full: Record<string, unknown> = {
    symbol: "PETR4",
    shortName: "PETROBRAS PN",
    currency: "BRL",
    regularMarketPrice: 36.65,
    regularMarketChangePercent: -0.95,
    regularMarketPreviousClose: 36.7,
    regularMarketVolume: 27681100,
    regularMarketTime: "2026-02-08T16:24:54.000Z",
    ...overrides,
  };
  const item = Object.fromEntries(Object.entries(full).filter(([key]) => !drop.includes(key)));
  return JSON.stringify({ results: [item] });
}

describe("BrapiProvider.fetchQuotes", () => {
  it("resposta válida vira RawQuote com preço decimal em string e classe inferida", async () => {
    const { provider } = setup(QUOTE_BODY);
    const quotes = await provider.fetchQuotes(["PETR4", "HGLG11"]);
    expect(quotes).toEqual([
      {
        symbol: "PETR4",
        name: "PETROBRAS PN",
        assetClass: "stock",
        price: "36.65",
        changePct: "-0.95",
        previousClose: "36.7",
        volume: "27681100",
        currency: "BRL",
        updatedAt: "2026-02-08T16:24:54.000Z",
        source: "brapi",
      },
      {
        symbol: "HGLG11",
        name: "CSHG LOG FII",
        assetClass: "fund",
        price: "162.1",
        changePct: "0.12",
        previousClose: "161.9",
        volume: "51234",
        currency: "BRL",
        updatedAt: "2026-02-08T16:20:00.000Z",
        source: "brapi",
      },
    ]);
    for (const q of quotes) expect(RawQuoteSchema.safeParse(q).success).toBe(true);
  });

  it("número com ruído de ponto flutuante não vira notação científica nem perde o formato", async () => {
    const { provider } = setup(
      quoteBody({ regularMarketPrice: 0.1 + 0.2, regularMarketChangePercent: 1e-7 }),
    );
    const [q] = await provider.fetchQuotes(["PETR4"]);
    expect(q?.price).toBe("0.3");
    expect(q?.changePct).toBe("0");
  });

  it("token vai no cabeçalho Authorization e nunca na URL; símbolos codificados no caminho", async () => {
    const { provider, fetchImpl } = setup(QUOTE_BODY);
    await provider.fetchQuotes(["PETR4", "^BVSP"]);
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    const url = String(input);
    expect(url).toBe("https://brapi.example/api/quote/PETR4,%5EBVSP");
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("token");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(init?.redirect).toBe("error");
  });

  it("sem token não manda Authorization", async () => {
    const { provider, fetchImpl } = setup(QUOTE_BODY, { token: undefined });
    await provider.fetchQuotes(["PETR4"]);
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
  });

  it.each([
    ["petr4"],
    ["PETR4/../x"],
    ["%2e"],
    [""],
    ["PETR4\n"],
    ["PETR4\u0000"],
    ["PETR4,VALE3"],
    ["ABCDEFGHIJKLM"],
  ])("símbolo malformado %j lança antes de chamar fetch", async (bad) => {
    const { provider, fetchImpl } = setup(QUOTE_BODY);
    await expect(provider.fetchQuotes(["PETR4", bad])).rejects.toBeInstanceOf(ValidationError);
    await expect(provider.fetchHistory(bad, "1mo")).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("mais de 20 símbolos lança antes de chamar fetch", async () => {
    const { provider, fetchImpl } = setup(QUOTE_BODY);
    const many = Array.from({ length: 21 }, (_, i) => `ABCD${String(i % 9)}`);
    await expect(provider.fetchQuotes(many)).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lista vazia não chama o provedor", async () => {
    const { provider, fetchImpl } = setup(QUOTE_BODY);
    expect(await provider.fetchQuotes([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["preço negativo", { regularMarketPrice: -1 }],
    ["preço zero", { regularMarketPrice: 0 }],
    ["preço string", { regularMarketPrice: "36.65" }],
    ["preço null", { regularMarketPrice: null }],
    ["preço gigante", { regularMarketPrice: 1e13 }],
    ["preço 1e308", { regularMarketPrice: 1e308 }],
    ["moeda estrangeira", { currency: "USD" }],
    ["símbolo não pedido", { symbol: "VALE3" }],
    ["símbolo malformado", { symbol: "petr4" }],
    ["horário inválido", { regularMarketTime: "ontem" }],
    ["horário null", { regularMarketTime: null }],
    ["item não objeto", null],
  ])("item com %s é descartado", async (_label, overrides) => {
    const body =
      overrides === null ? JSON.stringify({ results: [null, 3, "x"] }) : quoteBody(overrides);
    const { provider } = setup(body);
    expect(await provider.fetchQuotes(["PETR4"])).toEqual([]);
  });

  it.each(["regularMarketPrice", "symbol", "regularMarketTime"])(
    "item sem %s é descartado",
    async (field) => {
      const { provider } = setup(quoteBody({}, [field]));
      expect(await provider.fetchQuotes(["PETR4"])).toEqual([]);
    },
  );

  it("NaN e Infinity no corpo são JSON inválido e lançam", async () => {
    for (const raw of ["NaN", "Infinity", "-Infinity"]) {
      const body = quoteBody({ regularMarketPrice: 1 }).replace(
        '"regularMarketPrice":1',
        `"regularMarketPrice":${raw}`,
      );
      const { provider } = setup(body);
      await expect(provider.fetchQuotes(["PETR4"])).rejects.toBeInstanceOf(
        MarketDataUnavailableError,
      );
    }
  });

  it("campos opcionais com lixo viram null sem descartar a cotação", async () => {
    const { provider } = setup(
      quoteBody({
        regularMarketChangePercent: "x",
        regularMarketPreviousClose: -5,
        regularMarketVolume: 1.5,
      }),
    );
    const [q] = await provider.fetchQuotes(["PETR4"]);
    expect(q).toMatchObject({ price: "36.65", changePct: null, previousClose: null, volume: null });
    expect(RawQuoteSchema.safeParse(q).success).toBe(true);
  });

  it("nome com caracteres de controle é limpo e limitado; sem nome usa o símbolo", async () => {
    const { provider } = setup(quoteBody({ shortName: `A\u0000B\n${"x".repeat(500)}` }));
    const [q] = await provider.fetchQuotes(["PETR4"]);
    expect(q?.name).not.toMatch(/\p{Cc}/u);
    expect(q?.name.length).toBeLessThanOrEqual(120);

    const { provider: p2 } = setup(quoteBody({ shortName: null, longName: "  " }));
    expect((await p2.fetchQuotes(["PETR4"]))[0]?.name).toBe("PETR4");
  });

  it("resposta sem results ou com formato errado lança", async () => {
    for (const body of ['{"error":true}', "[]", '{"results":"x"}', "null"]) {
      const { provider } = setup(body);
      await expect(provider.fetchQuotes(["PETR4"])).rejects.toBeInstanceOf(
        MarketDataUnavailableError,
      );
    }
  });

  it("corpo acima de maxBytes lança", async () => {
    const { provider } = setup(QUOTE_BODY, { maxBytes: 64 });
    await expect(provider.fetchQuotes(["PETR4"])).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
  });

  it("JSON inválido lança", async () => {
    const { provider } = setup("{results:");
    await expect(provider.fetchQuotes(["PETR4"])).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
  });

  it("HTTP 500 lança e o log não leva token nem URL", async () => {
    const { provider, warn } = setup(
      () => new Response("erro interno do provedor", { status: 500 }),
    );
    await expect(provider.fetchQuotes(["PETR4"])).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("/quote/");
    expect(logged).not.toContain("erro interno do provedor");
  });

  it("erro de rede tem no máximo uma tentativa extra", async () => {
    const { provider, fetchImpl } = setup(QUOTE_BODY);
    fetchImpl.mockRejectedValue(new TypeError("fetch failed"));
    await expect(provider.fetchQuotes(["PETR4"])).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    fetchImpl.mockReset();
    fetchImpl
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(QUOTE_BODY));
    expect(await provider.fetchQuotes(["PETR4"])).toHaveLength(1);
  });
});

describe("BrapiProvider: hora da cotação", () => {
  it.each([
    ["2099-01-01T00:00:00Z"],
    ["1"],
    ["0"],
    ["12/31/2099"],
    ["2026-02-08T16:24:54"],
    ["2026-02-08"],
    ["1999-12-31T23:59:59Z"],
    [1770570294],
  ])("hora %j (futura, fora de ISO 8601 com offset ou abaixo do piso) descarta", async (time) => {
    const { provider } = setup(quoteBody({ regularMarketTime: time }));
    expect(await provider.fetchQuotes(["PETR4"])).toEqual([]);
  });

  it("hora exatamente em now + 2 min passa; 1 ms a mais descarta", async () => {
    const { provider: atLimit } = setup(
      quoteBody({ regularMarketTime: new Date(NOW + SKEW_MS).toISOString() }),
    );
    expect((await atLimit.fetchQuotes(["PETR4"]))[0]?.updatedAt).toBe(
      new Date(NOW + SKEW_MS).toISOString(),
    );
    const { provider: past } = setup(
      quoteBody({ regularMarketTime: new Date(NOW + SKEW_MS + 1).toISOString() }),
    );
    expect(await past.fetchQuotes(["PETR4"])).toEqual([]);
  });

  it("hora com offset é aceita e normalizada para UTC", async () => {
    const { provider } = setup(quoteBody({ regularMarketTime: "2026-02-09T08:00:00-03:00" }));
    expect((await provider.fetchQuotes(["PETR4"]))[0]?.updatedAt).toBe("2026-02-09T11:00:00.000Z");
  });
});

describe("BrapiProvider: 404 de ticker inexistente", () => {
  it("404 no formato de erro da brapi vira lista vazia, sem a mensagem no log", async () => {
    const { provider, warn } = setup(brapiNotFound);
    expect(await provider.fetchQuotes(["ZZZZ4"])).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Não encontramos");
  });

  it.each([
    ["<html>Not Found</html>"],
    ['{"error":"sim","message":"x"}'],
    ['{"message":"x"}'],
    ['{"error":true}'],
    ["[]"],
  ])("404 com outro corpo (%s) lança MarketDataUnavailableError", async (body) => {
    const { provider } = setup(() => new Response(body, { status: 404 }));
    await expect(provider.fetchQuotes(["ZZZZ4"])).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    await expect(provider.fetchHistory("ZZZZ4", "5d")).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
  });

  it("500 com o formato de erro da brapi continua lançando", async () => {
    const { provider } = setup(
      () => new Response(JSON.stringify({ error: true, message: "falha" }), { status: 500 }),
    );
    await expect(provider.fetchQuotes(["PETR4"])).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
  });

  it("lote misto: 200 sem o ticker desconhecido devolve só os encontrados", async () => {
    const { provider, fetchImpl } = setup(quoteBody({}));
    const quotes = await provider.fetchQuotes(["PETR4", "ZZZZ4"]);
    expect(quotes.map((q) => q.symbol)).toEqual(["PETR4"]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://brapi.example/api/quote/PETR4,ZZZZ4",
    );
  });
});

describe("BrapiProvider.fetchHistory", () => {
  it("histórico vira HistoricalBar com data de São Paulo e range/interval na query", async () => {
    const { provider, fetchImpl } = setup(HISTORY_BODY);
    const bars = await provider.fetchHistory("PETR4", "5d");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://brapi.example/api/quote/PETR4?range=5d&interval=1d",
    );
    expect(bars).toEqual([
      {
        date: "2026-02-02",
        open: "36.1",
        high: "36.9",
        low: "35.95",
        close: "36.8",
        volume: "30111200",
      },
      {
        date: "2026-02-03",
        open: "36.8",
        high: "37.05",
        low: "36.4",
        close: "36.5",
        volume: "28100300",
      },
      {
        date: "2026-02-04",
        open: "36.5",
        high: "36.75",
        low: "36.2",
        close: "36.7",
        volume: "25400700",
      },
    ]);
    for (const b of bars) expect(HistoricalBarSchema.safeParse(b).success).toBe(true);
  });

  it("range fora da lista lança antes de chamar fetch", async () => {
    const { provider, fetchImpl } = setup(HISTORY_BODY);
    await expect(provider.fetchHistory("PETR4", "max" as unknown as "5d")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("barras com lixo são descartadas, a ordem é por data e datas repetidas ficam uma vez", async () => {
    const bar = (date: unknown, close: unknown, extra: Record<string, unknown> = {}) => ({
      date,
      open: 10,
      high: 11,
      low: 9,
      close,
      volume: 100,
      ...extra,
    });
    const body = JSON.stringify({
      results: [
        {
          symbol: "PETR4",
          historicalDataPrice: [
            bar(1770202800, 10.5),
            bar(1770030000, 10),
            bar(1770030000, 10.1),
            bar(1770116400, -1),
            bar(1770116400, "10"),
            bar(1770116400, 1e15),
            bar("1770116400", 10),
            bar(1770116400, 10, { volume: null }),
            bar(1770116400, 10, { volume: -3 }),
            bar(Number.MAX_SAFE_INTEGER, 10),
            null,
          ],
        },
      ],
    });
    const { provider } = setup(body);
    const bars = await provider.fetchHistory("PETR4", "5d");
    expect(bars.map((b) => [b.date, b.close])).toEqual([
      ["2026-02-02", "10"],
      ["2026-02-04", "10.5"],
    ]);
  });

  it("barra com data futura (no calendário de São Paulo) é descartada; a do dia passa", async () => {
    const bar = (date: number) => ({ date, open: 10, high: 11, low: 9, close: 10, volume: 1 });
    const body = JSON.stringify({
      results: [
        {
          symbol: "PETR4",
          historicalDataPrice: [
            bar(1770030000), // 2026-02-02
            bar(1770667200), // 2026-02-09 17:00 em SP: mesmo dia de NOW
            bar(1770721200), // 2026-02-10: futuro
            bar(4_000_000_000), // 2096: futuro
          ],
        },
      ],
    });
    const { provider } = setup(body);
    const bars = await provider.fetchHistory("PETR4", "5d");
    expect(bars.map((b) => b.date)).toEqual(["2026-02-02", "2026-02-09"]);
  });

  it("404 no formato de erro da brapi vira histórico vazio", async () => {
    const { provider } = setup(brapiNotFound);
    expect(await provider.fetchHistory("ZZZZ4", "5d")).toEqual([]);
  });

  it("sem resultado para o símbolo pedido volta vazio", async () => {
    const { provider } = setup(
      JSON.stringify({ results: [{ symbol: "VALE3", historicalDataPrice: [] }] }),
    );
    expect(await provider.fetchHistory("PETR4", "5d")).toEqual([]);
  });
});
