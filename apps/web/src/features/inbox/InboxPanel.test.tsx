import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createEventBus, type PanelSignal } from "../../state/event-bus";
import { setApiKey } from "../../state/session";
import { TEST_KEY, approval, problem, use } from "../../test/helpers";
import { InboxPanel } from "./InboxPanel";

const ID = "a".repeat(64);

function mount(initial: unknown[] = [approval()]) {
  setApiKey(TEST_KEY);
  const lists: unknown[][] = [initial];
  let listCalls = 0;
  use(
    http.get("*/api/clients/cliente-moderado/inbox", () => {
      listCalls += 1;
      return HttpResponse.json(lists.at(-1));
    }),
  );
  const bus = createEventBus<PanelSignal>();
  const view = render(<InboxPanel clientId="cliente-moderado" bus={bus} />);
  return { bus, lists, listCalls: () => listCalls, view };
}

async function approveFlow(user: ReturnType<typeof userEvent.setup>) {
  const [first] = await screen.findAllByRole("button", { name: "Aprovar" });
  await user.click(first as HTMLElement);
  await user.click(screen.getByRole("button", { name: "Confirmar aprovação" }));
}

describe("InboxPanel", () => {
  it("lista pendentes com ação, valor em R$ e o payload visíveis antes de aprovar", async () => {
    mount();
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("transferir_valores")).toBeInTheDocument();
    expect(within(item).getByText(/R\$\s1\.500,00/)).toBeInTheDocument();
    expect(within(item).getByText(/conta-123/)).toBeInTheDocument();
    expect(within(item).getByText(/irrevers/i)).toBeInTheDocument();
  });

  it("aprovar chama POST /api/inbox/:id/decision com { approved: true } e o item sai no approval_executed", async () => {
    const { bus } = mount();
    let body: unknown;
    use(
      http.post("*/api/inbox/:id/decision", async ({ request, params }) => {
        body = { id: params["id"], json: await request.json() };
        return HttpResponse.json(approval({ status: "approved" }));
      }),
    );
    const user = userEvent.setup();
    await approveFlow(user);
    await screen.findByText(/aguardando a execução/i);
    expect(body).toEqual({ id: ID, json: { approved: true } });
    expect(screen.getByRole("listitem")).toBeInTheDocument();

    act(() => bus.publish({ type: "approval_executed", approvalId: ID, status: "succeeded" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent(/executada/i);
  });

  it("rejeitar manda { approved: false } e remove o item", async () => {
    mount();
    let body: unknown;
    use(
      http.post("*/api/inbox/:id/decision", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(approval({ status: "rejected" }));
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Rejeitar" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).not.toBeInTheDocument());
    expect(body).toEqual({ approved: false });
  });

  it("não permite envio duplo: um só POST mesmo com cliques repetidos", async () => {
    mount();
    let posts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    use(
      http.post("*/api/inbox/:id/decision", async () => {
        posts += 1;
        await gate;
        return HttpResponse.json(approval({ status: "approved" }));
      }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Aprovar" }));
    const confirm = screen.getByRole("button", { name: "Confirmar aprovação" });
    await user.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    await user.click(confirm);
    await user.click(confirm);
    expect(screen.getByRole("button", { name: "Rejeitar" })).toBeDisabled();
    release?.();
    await screen.findByText(/aguardando a execução/i);
    expect(posts).toBe(1);
  });

  it("403 mostra 'Esta chave não pode aprovar' e desabilita aprovar/rejeitar", async () => {
    mount([approval(), approval({ id: "b".repeat(64), action: "outra" })]);
    use(http.post("*/api/inbox/:id/decision", () => problem(403, "forbidden_scope")));
    const user = userEvent.setup();
    await approveFlow(user);
    expect(await screen.findByText("Esta chave não pode aprovar")).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /aprovar|rejeitar/i })) {
      expect(b).toBeDisabled();
    }
  });

  it("409 explica que já foi decidida/venceu e recarrega a lista", async () => {
    const { lists, listCalls } = mount();
    use(http.post("*/api/inbox/:id/decision", () => problem(409, "approval_conflict")));
    const user = userEvent.setup();
    await screen.findByRole("listitem");
    lists.push([]);
    await approveFlow(user);
    expect(await screen.findByText(/já foi decidida ou venceu/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("listitem")).not.toBeInTheDocument());
    expect(listCalls()).toBe(2);
  });

  it("approval_required (via barramento) adiciona o item, só do cliente atual", async () => {
    const { bus } = mount([]);
    await screen.findByText(/nenhuma aprovação pendente/i);
    act(() =>
      bus.publish({ type: "approval_required", approval: approval({ clientId: "outro" }) }),
    );
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    act(() => bus.publish({ type: "approval_required", approval: approval() }));
    expect(await screen.findByRole("listitem")).toBeInTheDocument();
  });

  it("socket_open recarrega a lista (eventos perdidos durante a queda)", async () => {
    const { bus, lists } = mount([]);
    await screen.findByText(/nenhuma aprovação pendente/i);
    lists.push([approval()]);
    act(() => bus.publish({ type: "socket_open" }));
    expect(await screen.findByRole("listitem")).toBeInTheDocument();
  });

  it("payload do inbox é texto: HTML/script não viram elementos", async () => {
    const { view } = mount([
      approval({
        action: "<img src=x onerror=alert(1)>",
        payload: { nota: '<script>alert(2)</script><img src=x onerror="alert(3)">' },
      }),
    ]);
    await screen.findByRole("listitem");
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });

  it("resposta inválida da lista vira estado de erro, sem renderizar", async () => {
    mount([{ id: 1, nada: "ver" }]);
    expect(await screen.findByRole("alert")).toHaveTextContent(/inesperad/i);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
