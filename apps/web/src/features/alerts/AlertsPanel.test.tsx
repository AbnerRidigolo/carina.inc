import type { PortfolioAlert } from "@carina/shared";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createEventBus, type PanelSignal } from "../../state/event-bus";
import { setApiKey } from "../../state/session";
import { TEST_KEY, problem, use } from "../../test/helpers";
import { AlertsPanel } from "./AlertsPanel";

const ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ID_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ID_3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

function alert(overrides: Partial<PortfolioAlert> = {}): PortfolioAlert {
  return {
    id: ID_1,
    assetCode: "PETR4",
    direction: "down",
    changePct: "-6.2",
    price: "31.40",
    tradingDay: "2026-11-20",
    createdAt: "2026-11-20T15:00:00.000Z",
    ...overrides,
  };
}

function mount(pages: { items: unknown[]; nextCursor: string | null }[]) {
  setApiKey(TEST_KEY);
  const cursors: (string | null)[] = [];
  let call = 0;
  use(
    http.get("*/api/clients/cliente-moderado/alerts", ({ request }) => {
      cursors.push(new URL(request.url).searchParams.get("cursor"));
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return HttpResponse.json(page ?? { items: [], nextCursor: null });
    }),
  );
  const bus = createEventBus<PanelSignal>();
  render(<AlertsPanel clientId="cliente-moderado" bus={bus} />);
  return { bus, cursors };
}

const text = (el: HTMLElement) => (el.textContent ?? "").replace(/\s/g, " ");

describe("AlertsPanel", () => {
  it("lista os alertas da API com o texto fixo", async () => {
    mount([
      {
        items: [
          alert(),
          alert({ id: ID_2, assetCode: "VALE3", direction: "up", changePct: "5.55", price: "70" }),
        ],
        nextCursor: null,
      },
    ]);
    const list = await screen.findByRole("list", { name: "Alertas da carteira" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map(text)).toEqual([
      expect.stringContaining("PETR4 caiu 6,2% hoje (R$ 31,40)."),
      expect.stringContaining("VALE3 subiu 5,6% hoje (R$ 70,00)."),
    ]);
  });

  it("alerta ao vivo entra no topo e não duplica um já listado", async () => {
    const { bus } = mount([{ items: [alert()], nextCursor: null }]);
    await screen.findByText(/PETR4 caiu/);
    act(() =>
      bus.publish({
        type: "portfolio_alert",
        alert: alert({
          id: ID_2,
          assetCode: "ITUB4",
          direction: "up",
          changePct: "5.1",
          price: "30",
        }),
      }),
    );
    act(() => bus.publish({ type: "portfolio_alert", alert: alert() }));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(text(items[0] as HTMLElement)).toContain("ITUB4 subiu 5,1% hoje (R$ 30,00).");
    expect(text(items[1] as HTMLElement)).toContain("PETR4 caiu");
  });

  it("carregar mais usa o cursor", async () => {
    const user = userEvent.setup();
    const { cursors } = mount([
      { items: [alert()], nextCursor: "cur-1" },
      { items: [alert({ id: ID_3, assetCode: "BBDC4" })], nextCursor: null },
    ]);
    await screen.findByText(/PETR4 caiu/);
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    await screen.findByText(/BBDC4 caiu/);
    expect(cursors).toEqual([null, "cur-1"]);
    expect(screen.queryByRole("button", { name: "Carregar mais" })).not.toBeInTheDocument();
  });

  it("estado vazio", async () => {
    mount([{ items: [], nextCursor: null }]);
    expect(await screen.findByText("Nenhum alerta hoje.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Alertas da carteira" })).not.toBeInTheDocument();
  });

  it("rodapé diz que não é recomendação", async () => {
    mount([{ items: [], nextCursor: null }]);
    expect(
      await screen.findByText(
        "Variação do dia em relação ao fechamento anterior. Não é recomendação de investimento.",
      ),
    ).toBeInTheDocument();
  });

  it("erro ao carregar mostra aviso", async () => {
    setApiKey(TEST_KEY);
    use(http.get("*/api/clients/cliente-moderado/alerts", () => problem(500, "internal")));
    render(<AlertsPanel clientId="cliente-moderado" bus={createEventBus<PanelSignal>()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/não foi possível carregar/i);
  });

  it("renderiza o código do ativo como texto, sem interpretar HTML", async () => {
    mount([{ items: [alert({ assetCode: "<img src=x onerror=alert(1)>" })], nextCursor: null }]);
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)> caiu/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
