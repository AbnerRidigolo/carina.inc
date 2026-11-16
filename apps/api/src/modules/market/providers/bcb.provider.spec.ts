import { readFileSync } from "node:fs";
import { MacroIndicatorSchema } from "@carina/shared";
import { describe, expect, it, vi } from "vitest";
import { MarketDataUnavailableError } from "../../../core/errors/domain-errors.js";
import { BcbProvider } from "./bcb.provider.js";
import type { MarketLogger } from "./safe-fetch.js";

// Fixtures RECONSTRUÍDAS (não gravadas: o sandbox não alcança api.bcb.gov.br) no formato
// documentado pelo Portal de Dados Abertos do BCB para
// /dados/serie/bcdata.sgs.{codigo}/dados/ultimos/{N}?formato=json: [{ "data": "dd/MM/aaaa",
// "valor": "<decimal em texto>" }]. Os valores são plausíveis, não oficiais.
const fixture = (id: number) =>
  readFileSync(new URL(`./fixtures/sgs-${String(id)}.reconstructed.json`, import.meta.url), "utf8");

const BASE = "https://sgs.example/dados/serie";
const NOW = Date.parse("2026-11-14T12:00:00.000Z");

function setup(bodies: Partial<Record<number, string | Response>> = {}) {
  const fetchImpl = vi.fn<typeof fetch>((input) => {
    const match = /bcdata\.sgs\.(\d+)\//.exec(String(input));
    const id = Number(match?.[1]);
    const body = id in bodies ? bodies[id] : fixture(id);
    return Promise.resolve(body instanceof Response ? body : new Response(body ?? "[]"));
  });
  const warn = vi.fn<MarketLogger["warn"]>();
  const provider = new BcbProvider({
    baseUrl: BASE,
    timeoutMs: 1000,
    maxBytes: 4096,
    fetchImpl,
    logger: { warn },
    now: () => NOW,
  });
  return { provider, fetchImpl, warn };
}

describe("BcbProvider.fetchMacro", () => {
  it("as quatro séries viram MacroIndicator com valor decimal em string", async () => {
    const { provider, fetchImpl } = setup();
    const macro = await provider.fetchMacro();
    expect(macro).toEqual([
      {
        code: "selic",
        name: "Meta Selic",
        value: "14.75",
        unit: "% a.a.",
        referenceDate: "2026-11-05",
      },
      {
        code: "cdi",
        name: "CDI anualizado",
        value: "14.65",
        unit: "% a.a.",
        referenceDate: "2026-11-13",
      },
      {
        code: "ipca",
        name: "IPCA (variação mensal)",
        value: "0.52",
        unit: "% a.m.",
        referenceDate: "2026-10-01",
      },
      {
        code: "ptax_usd",
        name: "Dólar PTAX (venda)",
        value: "5.4512",
        unit: "BRL/USD",
        referenceDate: "2026-11-13",
      },
    ]);
    for (const m of macro) expect(MacroIndicatorSchema.safeParse(m).success).toBe(true);
    expect(fetchImpl.mock.calls.map(([u]) => String(u)).sort()).toEqual(
      [432, 4389, 433, 1]
        .map((id) => `${BASE}/bcdata.sgs.${String(id)}/dados/ultimos/1?formato=json`)
        .sort(),
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("referenceDate futura além de 1 dia é omitida; até 1 dia passa", async () => {
    const { provider } = setup({
      433: '[{"data":"16/11/2026","valor":"0.5"}]',
      1: '[{"data":"15/11/2026","valor":"5.40"}]',
    });
    const macro = await provider.fetchMacro();
    expect(macro.map((m) => [m.code, m.referenceDate])).toEqual([
      ["selic", "2026-11-05"],
      ["cdi", "2026-11-13"],
      ["ptax_usd", "2026-11-15"],
    ]);
  });

  it("série vazia é omitida", async () => {
    const { provider } = setup({ 433: "[]" });
    const macro = await provider.fetchMacro();
    expect(macro.map((m) => m.code)).toEqual(["selic", "cdi", "ptax_usd"]);
  });

  it("vírgula decimal é aceita e valor negativo é preservado com sinal", async () => {
    const { provider } = setup({ 433: '[{"data":"01/10/2026","valor":"-0,21"}]' });
    const ipca = (await provider.fetchMacro()).find((m) => m.code === "ipca");
    expect(ipca?.value).toBe("-0.21");
  });

  it.each([
    ['[{"data":"01/10/2026","valor":"abc"}]'],
    ['[{"data":"01/10/2026","valor":"1e5"}]'],
    ['[{"data":"01/10/2026","valor":"9999999999999"}]'],
    ['[{"data":"01/10/2026","valor":12.5}]'],
    ['[{"data":"2026-10-01","valor":"0.5"}]'],
    ['[{"data":"31/02/2026","valor":"0.5"}]'],
    ['[{"valor":"0.5"}]'],
  ])("item com lixo é omitido (%s)", async (body) => {
    const { provider } = setup({ 433: body });
    const macro = await provider.fetchMacro();
    expect(macro.map((m) => m.code)).toEqual(["selic", "cdi", "ptax_usd"]);
  });

  it("formato inesperado da resposta lança", async () => {
    const { provider } = setup({ 432: '{"valor":"1"}' });
    await expect(provider.fetchMacro()).rejects.toBeInstanceOf(MarketDataUnavailableError);
  });

  it("erro HTTP lança", async () => {
    const { provider } = setup({ 4389: new Response("indisponível", { status: 503 }) });
    await expect(provider.fetchMacro()).rejects.toBeInstanceOf(MarketDataUnavailableError);
  });

  it("página HTML com status 200 (série inválida no SGS) lança", async () => {
    const { provider } = setup({ 1: "<html>Requisição inválida!</html>" });
    await expect(provider.fetchMacro()).rejects.toBeInstanceOf(MarketDataUnavailableError);
  });

  it("corpo acima de maxBytes lança", async () => {
    const big = JSON.stringify(
      Array.from({ length: 500 }, () => ({ data: "01/10/2026", valor: "0.52" })),
    );
    const { provider } = setup({ 433: big });
    await expect(provider.fetchMacro()).rejects.toBeInstanceOf(MarketDataUnavailableError);
  });
});
