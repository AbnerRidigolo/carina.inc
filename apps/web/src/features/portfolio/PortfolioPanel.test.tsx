import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { setApiKey } from "../../state/session";
import { TEST_KEY, use } from "../../test/helpers";
import { PortfolioPanel } from "./PortfolioPanel";

function pos(externalId: string, assetClass: string, valueBrl: string, extra = {}) {
  return {
    externalId,
    institution: "Banco X",
    kind: assetClass === "caixa" ? "cash" : "investment",
    assetClass,
    name: `Ativo ${externalId}`,
    valueBrl,
    asOf: "2026-11-10",
    ...extra,
  };
}

describe("PortfolioPanel", () => {
  it("agrupa por classe com subtotal exato em R$", async () => {
    setApiKey(TEST_KEY);
    use(
      http.get("*/api/clients/cliente-moderado/positions", () =>
        HttpResponse.json({
          positions: [
            pos("a", "acao", "0.10", { assetCode: "PETR4" }),
            pos("b", "acao", "0.20"),
            pos("c", "fii", "1000.00"),
            pos("d", "caixa", "50.55"),
          ],
          nextCursor: null,
        }),
      ),
    );
    render(<PortfolioPanel clientId="cliente-moderado" />);
    const acoes = await screen.findByRole("region", { name: /ações/i });
    expect(within(acoes).getByText(/R\$\s0,30/)).toBeInTheDocument();
    expect(within(acoes).getByText("PETR4")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: /fundos imobiliários/i })).getAllByText(
        /R\$\s1\.000,00/,
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: /caixa/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ver mais/i })).not.toBeInTheDocument();
  });

  it("pagina por cursor: 'Ver mais' pede ?after= e junta sem duplicar", async () => {
    setApiKey(TEST_KEY);
    const urls: string[] = [];
    use(
      http.get("*/api/clients/cliente-moderado/positions", ({ request }) => {
        urls.push(request.url);
        const after = new URL(request.url).searchParams.get("after");
        return HttpResponse.json(
          after === null
            ? { positions: [pos("a", "acao", "10.00")], nextCursor: "cursor/1+==" }
            : {
                positions: [pos("a", "acao", "10.00"), pos("b", "acao", "5.00")],
                nextCursor: null,
              },
        );
      }),
    );
    render(<PortfolioPanel clientId="cliente-moderado" />);
    const user = userEvent.setup();
    await screen.findByText("Ativo a");
    expect(screen.getByText(/posições carregadas/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /ver mais/i }));
    await screen.findByText("Ativo b");
    expect(screen.getAllByText("Ativo a")).toHaveLength(1);
    expect(new URL(urls[1] ?? "").searchParams.get("after")).toBe("cursor/1+==");
    expect(screen.queryByRole("button", { name: /ver mais/i })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: /ações/i })).getByText(/R\$\s15,00/),
    ).toBeInTheDocument();
  });

  it("resposta fora do schema vira alerta", async () => {
    setApiKey(TEST_KEY);
    use(
      http.get("*/api/clients/cliente-moderado/positions", () =>
        HttpResponse.json({ positions: [{ x: 1 }], nextCursor: null }),
      ),
    );
    render(<PortfolioPanel clientId="cliente-moderado" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/inesperad/i);
  });

  it("carteira vazia mostra mensagem", async () => {
    setApiKey(TEST_KEY);
    use(
      http.get("*/api/clients/cliente-moderado/positions", () =>
        HttpResponse.json({ positions: [], nextCursor: null }),
      ),
    );
    render(<PortfolioPanel clientId="cliente-moderado" />);
    expect(await screen.findByText(/sem posições/i)).toBeInTheDocument();
  });
});
