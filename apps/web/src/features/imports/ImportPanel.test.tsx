import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createEventBus, type PanelSignal } from "../../state/event-bus";
import { setApiKey } from "../../state/session";
import { TEST_KEY, problem, use } from "../../test/helpers";
import { ImportPanel } from "./ImportPanel";

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    format: "ofx",
    fileName: "extrato-out.ofx",
    status: "done",
    failureCode: null,
    stats: { rowsRead: 212, positions: 0, transactions: 212, errorRows: 0, ignored: {} },
    errors: [],
    createdAt: "2026-11-16T10:00:00.000Z",
    updatedAt: "2026-11-16T10:00:05.000Z",
    ...overrides,
  };
}

function mount(items: unknown[] = []) {
  setApiKey(TEST_KEY);
  let listCalls = 0;
  let current = items;
  use(
    http.get("*/api/clients/cliente-moderado/imports", () => {
      listCalls += 1;
      return HttpResponse.json({ items: current, nextCursor: null });
    }),
  );
  const bus = createEventBus<PanelSignal>();
  render(<ImportPanel clientId="cliente-moderado" bus={bus} />);
  return {
    bus,
    listCalls: () => listCalls,
    setItems: (next: unknown[]) => {
      current = next;
    },
  };
}

function pick(user: ReturnType<typeof userEvent.setup>, name = "extrato.ofx") {
  const input = screen.getByLabelText("Arquivo");
  return user.upload(input, new File(["conteudo"], name, { type: "application/octet-stream" }));
}

describe("ImportPanel", () => {
  it("só mostra os campos de CSV quando o formato CSV é escolhido", async () => {
    mount();
    const user = userEvent.setup();
    expect(screen.queryByLabelText(/preset/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/instituição/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "CSV" }));
    expect(screen.getByLabelText(/preset/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/instituição/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/conta/i)).toHaveValue("conta");
    await user.click(screen.getByRole("radio", { name: "B3" }));
    expect(screen.queryByLabelText(/preset/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/data da posição/i)).toBeInTheDocument();
  });

  it("o preset nubank_conta preenche a instituição com Nubank", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "CSV" }));
    await user.selectOptions(screen.getByLabelText(/preset/i), "nubank_conta");
    expect(screen.getByLabelText(/instituição/i)).toHaveValue("Nubank");
  });

  it("enviar manda o multipart com os campos certos e recarrega a lista", async () => {
    const { listCalls } = mount();
    let form: FormData | undefined;
    use(
      http.post("*/api/clients/cliente-moderado/imports", async ({ request }) => {
        form = await request.formData();
        return HttpResponse.json(job({ status: "queued", format: "csv" }), { status: 202 });
      }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "CSV" }));
    await user.selectOptions(screen.getByLabelText(/preset/i), "nubank_conta");
    await pick(user, "gastos.csv");
    await user.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(form).toBeDefined());
    expect(form?.get("format")).toBe("csv");
    expect(form?.get("csvPreset")).toBe("nubank_conta");
    expect(form?.get("institution")).toBe("Nubank");
    expect(form?.get("account")).toBe("conta");
    expect(form?.get("asOf")).toBeNull();
    expect(await (form?.get("file") as Blob).text()).toBe("conteudo");
    await waitFor(() => expect(listCalls()).toBeGreaterThanOrEqual(2));
  });

  it("formato automático não manda format nem campos de CSV; B3 manda asOf", async () => {
    mount();
    const forms: FormData[] = [];
    use(
      http.post("*/api/clients/cliente-moderado/imports", async ({ request }) => {
        forms.push(await request.formData());
        return HttpResponse.json(job(), { status: 200 });
      }),
    );
    const user = userEvent.setup();
    await pick(user);
    await user.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(forms).toHaveLength(1));
    expect(forms[0]?.get("format")).toBeNull();
    expect(forms[0]?.get("institution")).toBeNull();

    await user.click(screen.getByRole("radio", { name: "B3" }));
    await user.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(forms).toHaveLength(2));
    expect(forms[1]?.get("format")).toBe("b3_xlsx");
    expect(forms[1]?.get("asOf")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("413 mostra o detail do problem+json", async () => {
    mount();
    use(
      http.post("*/api/clients/cliente-moderado/imports", () => problem(413, "payload_too_large")),
    );
    const user = userEvent.setup();
    await pick(user);
    await user.click(screen.getByRole("button", { name: "Importar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("detalhe payload_too_large");
  });

  it("import_progress 500/1000 mostra 'processando 50%'", async () => {
    const { bus } = mount([job({ status: "parsing", stats: { ...job().stats, rowsRead: 0 } })]);
    expect(await screen.findByText("processando 0%")).toBeInTheDocument();
    act(() =>
      bus.publish({
        type: "import_progress",
        importJobId: JOB_ID,
        stage: "parsing",
        processed: 500,
        total: 1000,
      }),
    );
    expect(await screen.findByText("processando 50%")).toBeInTheDocument();
  });

  it("job na fila que recebe import_progress passa a mostrar processando", async () => {
    const { bus } = mount([job({ status: "queued" })]);
    expect(await screen.findByText("na fila")).toBeInTheDocument();
    act(() =>
      bus.publish({
        type: "import_progress",
        importJobId: JOB_ID,
        stage: "parsing",
        processed: 500,
        total: 1000,
      }),
    );
    expect(await screen.findByText("processando 50%")).toBeInTheDocument();
  });

  it("status na fila", async () => {
    mount([job({ status: "queued" })]);
    expect(await screen.findByText("na fila")).toBeInTheDocument();
  });

  it("import_finished recarrega a lista", async () => {
    const { bus, listCalls, setItems } = mount([job({ status: "parsing" })]);
    await screen.findByText(/processando/);
    const before = listCalls();
    setItems([job()]);
    act(() => bus.publish({ type: "import_finished", importJobId: JOB_ID, status: "done" }));
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    const row = (await screen.findAllByRole("listitem"))[0] as HTMLElement;
    expect(within(row).getByText("concluído")).toBeInTheDocument();
    expect(within(row).getByText(/212 transações/)).toBeInTheDocument();
  });

  it("failed com expired mostra a mensagem em português", async () => {
    mount([job({ status: "failed", failureCode: "expired" })]);
    expect(await screen.findByText(/falhou: o arquivo expirou/i)).toBeInTheDocument();
  });

  it("mostra no máximo 10 erros por linha", async () => {
    const errors = Array.from({ length: 15 }, (_, i) => ({
      row: i + 2,
      code: "invalid_date",
      message: `data inválida ${i}`,
    }));
    mount([job({ errors, stats: { ...job().stats, errorRows: 15 } })]);
    await screen.findByText("concluído");
    expect(screen.getAllByText(/data inválida/)).toHaveLength(10);
    expect(screen.getByText(/linha 2: data inválida 0/)).toBeInTheDocument();
  });
});
