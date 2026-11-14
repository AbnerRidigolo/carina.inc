import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { getApiKey } from "../../state/session";
import { CLIENTS, TEST_KEY, problem, use } from "../../test/helpers";
import { ConnectScreen } from "./ConnectScreen";

async function submit(key: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Chave de API"), key);
  await user.click(screen.getByRole("button", { name: "Conectar" }));
}

describe("ConnectScreen", () => {
  it("chave inválida (401) mostra 'Chave inválida' e não guarda nada", async () => {
    use(http.get("*/api/clients", () => problem(401, "unauthenticated")));
    const onConnected = vi.fn();
    render(<ConnectScreen onConnected={onConnected} />);
    await submit("sk-live-errada");
    expect(await screen.findByRole("alert")).toHaveTextContent("Chave inválida");
    expect(onConnected).not.toHaveBeenCalled();
    expect(getApiKey()).toBeNull();
  });

  it("chave válida guarda na sessão e entrega os clientes ao App", async () => {
    let auth: string | null = null;
    use(
      http.get("*/api/clients", ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json(CLIENTS);
      }),
    );
    const onConnected = vi.fn();
    render(<ConnectScreen onConnected={onConnected} />);
    await submit(`  ${TEST_KEY}  `);
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onConnected.mock.calls[0]?.[0]).toEqual(CLIENTS);
    expect(auth).toBe(`Bearer ${TEST_KEY}`);
    expect(getApiKey()).toBe(TEST_KEY);
  });

  it("403 (sem escopo chat) explica o escopo; 429/rede mostram erro temporário", async () => {
    use(http.get("*/api/clients", () => problem(403, "forbidden_scope")));
    render(<ConnectScreen onConnected={() => undefined} />);
    await submit(TEST_KEY);
    expect(await screen.findByRole("alert")).toHaveTextContent(/escopo/i);
    expect(getApiKey()).toBeNull();
  });

  it("resposta fora do schema não conecta", async () => {
    use(http.get("*/api/clients", () => HttpResponse.json([{ foo: 1 }])));
    const onConnected = vi.fn();
    render(<ConnectScreen onConnected={onConnected} />);
    await submit(TEST_KEY);
    expect(await screen.findByRole("alert")).toHaveTextContent(/inesperad/i);
    expect(onConnected).not.toHaveBeenCalled();
    expect(getApiKey()).toBeNull();
  });

  it("tem rótulo, campo de senha, ajuda sobre as chaves de demo e nunca exibe a chave", async () => {
    render(<ConnectScreen onConnected={() => undefined} notice="Chave expirada." />);
    const input = screen.getByLabelText("Chave de API");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByText(/DEMO_APP_KEY/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Chave expirada.");
  });
});
