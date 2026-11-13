import { act, render, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createEventBus, type PanelSignal } from "../../state/event-bus";
import { setApiKey } from "../../state/session";
import { TEST_KEY, problem, use } from "../../test/helpers";
import { UsagePanel } from "./UsagePanel";

const USAGE = {
  month: "2026-11",
  resolutions: 3,
  totalBrl: "22.50",
  byWorkType: {
    analysis: { count: 2, totalBrl: "15.00" },
    query: { count: 1, totalBrl: "7.50" },
  },
};
const AUDIT = [
  {
    id: "e1",
    clientId: "11111111-1111-4111-8111-111111111111",
    channel: "ws",
    query: "<img src=x onerror=alert(1)> rentabilidade garantida",
    agents: ["insight", "risk"],
    flags: [{ code: "promessa_rentabilidade", severity: "violation", detail: "Promete retorno" }],
    durationMs: 1200,
    createdAt: "2026-11-12T10:00:00.000Z",
  },
  {
    id: "e2",
    channel: "rest",
    query: "tudo certo",
    agents: ["insight"],
    flags: [],
    durationMs: 800,
    createdAt: "2026-11-12T09:00:00.000Z",
  },
];

function mount() {
  setApiKey(TEST_KEY);
  let usageCalls = 0;
  let auditUrl = "";
  use(
    http.get("*/api/usage", () => {
      usageCalls += 1;
      return HttpResponse.json(USAGE);
    }),
    http.get("*/api/audit", ({ request }) => {
      auditUrl = request.url;
      return HttpResponse.json(AUDIT);
    }),
  );
  const bus = createEventBus<PanelSignal>();
  const view = render(<UsagePanel bus={bus} />);
  return { bus, view, usageCalls: () => usageCalls, auditUrl: () => auditUrl };
}

describe("UsagePanel", () => {
  it("deixa claro que uso e auditoria são do tenant inteiro, não do cliente selecionado", async () => {
    mount();
    const panel = await screen.findByRole("region", { name: /uso e auditoria/i });
    expect(within(panel).getByText(/todos os clientes/i)).toBeInTheDocument();
  });

  it("mostra totais do mês em R$ e a divisão por tipo de trabalho", async () => {
    mount();
    expect(await screen.findByText(/R\$\s22,50/)).toBeInTheDocument();
    expect(screen.getByText(/novembro de 2026/i)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /por tipo de trabalho/i });
    expect(within(table).getByText(/R\$\s15,00/)).toBeInTheDocument();
    expect(within(table).getByText(/R\$\s7,50/)).toBeInTheDocument();
  });

  it("destaca as flags de compliance (com texto, não só cor) e mostra a consulta como texto", async () => {
    const { view, auditUrl } = mount();
    const violation = await screen.findByText(/promessa_rentabilidade/);
    expect(violation.closest("[data-severity='violation']")).not.toBeNull();
    expect(screen.getByText(/violação/i)).toBeInTheDocument();
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(new URL(auditUrl()).searchParams.get("limit")).toBe("20");
  });

  it("recarrega quando um turno termina (done no barramento)", async () => {
    const { bus, usageCalls } = mount();
    await screen.findByText(/R\$\s22,50/);
    act(() =>
      bus.publish({
        type: "done",
        threadId: "t",
        status: "completed",
        answer: "",
        usage: { workType: "query", priceBrl: "7.50" },
        compliance: { auditId: "a", flags: [] },
      }),
    );
    await screen.findByText(/R\$\s22,50/);
    await vi_waitFor(() => expect(usageCalls()).toBe(2));
  });

  it("erro da API vira alerta", async () => {
    setApiKey(TEST_KEY);
    use(
      http.get("*/api/usage", () => problem(503, "all_providers_failed", { "Retry-After": "30" })),
      http.get("*/api/audit", () => HttpResponse.json([])),
    );
    render(<UsagePanel bus={createEventBus<PanelSignal>()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/não foi possível/i);
  });
});

import { vi } from "vitest";
const vi_waitFor = vi.waitFor;
