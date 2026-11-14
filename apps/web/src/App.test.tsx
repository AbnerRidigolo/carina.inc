import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getApiKey, setApiKey } from "./state/session";
import { FakeWebSocket } from "./test/fake-websocket";
import { CLIENTS, TEST_KEY, problem, ticketHandler, use } from "./test/helpers";

function baseHandlers() {
  use(
    http.get("*/api/clients", () => HttpResponse.json(CLIENTS)),
    ticketHandler(),
    http.get("*/api/clients/:id/inbox", () => HttpResponse.json([])),
    http.get("*/api/clients/:id/positions", () =>
      HttpResponse.json({ positions: [], nextCursor: null }),
    ),
    http.get("*/api/usage", () =>
      HttpResponse.json({ month: "2026-11", resolutions: 0, totalBrl: "0.00", byWorkType: {} }),
    ),
    http.get("*/api/audit", () => HttpResponse.json([])),
  );
}

describe("App", () => {
  it("sem chave mostra a tela de conexão; com chave válida mostra o app com o seletor de cliente", async () => {
    baseHandlers();
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Chave de API"), TEST_KEY);
    await user.click(screen.getByRole("button", { name: "Conectar" }));
    const select = await screen.findByLabelText("Cliente");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["cliente-moderado", "cliente-arrojado"]);
    expect(screen.queryByText(TEST_KEY)).not.toBeInTheDocument();
    expect(screen.getByText(/sk-live-…/)).toBeInTheDocument();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  });

  it("trocar o cliente fecha o socket antigo e abre outro; Sair apaga a chave", async () => {
    setApiKey(TEST_KEY);
    baseHandlers();
    render(<App />);
    const user = userEvent.setup();
    const select = await screen.findByLabelText("Cliente");
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await user.selectOptions(select, "cliente-arrojado");
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(FakeWebSocket.instances[0]?.closeCalls).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Sair" }));
    expect(await screen.findByLabelText("Chave de API")).toBeInTheDocument();
    expect(getApiKey()).toBeNull();
    expect(FakeWebSocket.instances[1]?.closeCalls).toHaveLength(1);
  });

  it("um 401 em qualquer chamada volta à conexão com aviso de chave inválida/expirada", async () => {
    setApiKey(TEST_KEY);
    baseHandlers();
    use(http.get("*/api/usage", () => problem(401, "unauthenticated")));
    render(<App />);
    expect(await screen.findByLabelText("Chave de API")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/inválida ou expirada/i);
    expect(getApiKey()).toBeNull();
  });

  it("com o sessionStorage bloqueado a tela ainda renderiza e conecta (chave só em memória)", async () => {
    const boom = () => {
      throw new DOMException("bloqueado", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    baseHandlers();
    render(<App />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Chave de API"), TEST_KEY);
    await user.click(screen.getByRole("button", { name: "Conectar" }));
    expect(await screen.findByLabelText("Cliente")).toBeInTheDocument();
  });
});
