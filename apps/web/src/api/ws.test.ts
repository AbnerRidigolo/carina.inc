import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@carina/shared";
import { setApiKey } from "../state/session";
import { FakeWebSocket } from "../test/fake-websocket";
import { TEST_KEY, problem, ticketHandler, use } from "../test/helpers";
import { type ChatStatus, connectChat } from "./ws";

function setup() {
  setApiKey(TEST_KEY);
  const tickets: { body: unknown; auth: string | null }[] = [];
  use(ticketHandler((body, headers) => tickets.push({ body, auth: headers.get("authorization") })));
  const events: ChatEvent[] = [];
  const statuses: ChatStatus[] = [];
  const opts = {
    clientId: "cliente-moderado",
    onEvent: (e: ChatEvent) => events.push(e),
    onStatus: (s: ChatStatus) => statuses.push(s),
  };
  return { tickets, events, statuses, opts };
}

async function sockets(n: number) {
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(n));
  return FakeWebSocket.last();
}

describe("connectChat", () => {
  it("pede um ticket (com a chave só no header) e abre o socket só com o ticket na URL", async () => {
    const { tickets, opts } = setup();
    const logs = ["log", "info", "debug"].map((m) =>
      vi.spyOn(console, m as "log").mockImplementation(() => undefined),
    );
    const promise = connectChat(opts);
    const socket = await sockets(1);
    socket.serverOpen();
    const conn = await promise;

    expect(tickets).toEqual([
      { body: { clientId: "cliente-moderado" }, auth: `Bearer ${TEST_KEY}` },
    ]);
    const url = new URL(socket.url);
    expect(url.pathname).toBe("/ws/chat");
    expect([...url.searchParams.keys()]).toEqual(["ticket"]);
    expect(url.searchParams.get("ticket")).toHaveLength(43);
    expect(socket.url).not.toContain(TEST_KEY);
    expect(socket.url).not.toContain("sk-live");
    expect(url.protocol).toBe("ws:");
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    conn.close();
  });

  it("valida cada mensagem com ChatEventSchema: inválidas são descartadas e viram erro de protocolo", async () => {
    const { events, statuses, opts } = setup();
    const promise = connectChat(opts);
    const socket = await sockets(1);
    socket.serverOpen();
    const conn = await promise;

    socket.serverMessage({ type: "agent_started", agent: "insight" });
    socket.serverMessage({ type: "agent_started", agent: "hacker" });
    socket.serverMessage("isto não é json");
    socket.serverMessage({ type: "token", agent: "insight", text: 42 });
    expect(events).toEqual([{ type: "agent_started", agent: "insight" }]);
    expect(statuses.filter((s) => s.state === "protocol_error")).toHaveLength(3);
    conn.close();
  });

  it("send valida o ChatRequest e escreve JSON; recusa mensagem vazia", async () => {
    const { opts } = setup();
    const promise = connectChat(opts);
    const socket = await sockets(1);
    socket.serverOpen();
    const conn = await promise;
    conn.send({ clientId: "cliente-moderado", message: "oi" });
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      clientId: "cliente-moderado",
      message: "oi",
    });
    expect(() => conn.send({ clientId: "cliente-moderado", message: "   " })).toThrow();
    expect(socket.sent).toHaveLength(1);
    conn.close();
  });

  it("send falha com erro claro se o socket não está aberto", async () => {
    const { opts } = setup();
    const promise = connectChat(opts);
    const socket = await sockets(1);
    socket.serverOpen();
    const conn = await promise;
    socket.serverClose(1006);
    expect(() => conn.send({ clientId: "cliente-moderado", message: "oi" })).toThrow(/conectad/i);
    conn.close();
  });

  it("reconecta com backoff de 1 s, 2 s e 4 s, com ticket novo a cada tentativa, e desiste", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { tickets, statuses, opts } = setup();
    const promise = connectChat(opts);
    promise.catch(() => undefined);
    let socket = await sockets(1);
    socket.serverOpen();
    await promise;

    socket.serverClose(1006);
    expect(statuses.at(-1)).toMatchObject({ state: "reconnecting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(tickets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    socket = await sockets(2);
    expect(tickets).toHaveLength(2);

    socket.serverClose(1006); // nunca abriu: segunda falha seguida
    await vi.advanceTimersByTimeAsync(1999);
    expect(tickets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    socket = await sockets(3);
    socket.serverClose(1006);
    await vi.advanceTimersByTimeAsync(3999);
    expect(tickets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    socket = await sockets(4);
    socket.serverClose(1006);

    expect(statuses.at(-1)).toMatchObject({ state: "offline" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tickets).toHaveLength(4);
    const urls = FakeWebSocket.instances.map((s) => new URL(s.url).searchParams.get("ticket"));
    expect(new Set(urls).size).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("4401 por vida máxima (conexão estável) reconecta com ticket novo", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { tickets, statuses, opts } = setup();
    const promise = connectChat(opts);
    let socket = await sockets(1);
    socket.serverOpen();
    const conn = await promise;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    socket.serverClose(4401, "connection expired");
    socket = await sockets(2);
    socket.serverOpen();
    expect(tickets).toHaveLength(2);
    expect(statuses.at(-1)).toMatchObject({ state: "open" });
    conn.close();
  });

  it("4401 repetido logo após abrir (chave inválida) NÃO entra em loop: para e avisa", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { tickets, statuses, opts } = setup();
    const promise = connectChat(opts);
    let socket = await sockets(1);
    socket.serverOpen();
    await promise;
    socket.serverClose(4401, "unauthorized");
    await vi.advanceTimersByTimeAsync(1000);
    socket = await sockets(2);
    socket.serverOpen();
    socket.serverClose(4401, "unauthorized");
    expect(statuses.at(-1)).toMatchObject({ state: "unauthorized" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tickets).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("error unauthenticated do servidor para a reconexão na hora", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { tickets, events, statuses, opts } = setup();
    const promise = connectChat(opts);
    const socket = await sockets(1);
    socket.serverOpen();
    await promise;
    socket.serverMessage({ type: "error", code: "unauthenticated", traceId: "t" });
    socket.serverClose(4401, "unauthorized");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses.at(-1)).toMatchObject({ state: "unauthorized" });
    expect(events).toHaveLength(1);
    expect(tickets).toHaveLength(1);
  });

  it("ticket negado com 401 rejeita a promise e não tenta de novo", async () => {
    setApiKey(TEST_KEY);
    let calls = 0;
    use(
      http.post("*/api/ws/ticket", () => {
        calls += 1;
        return problem(401, "unauthenticated");
      }),
    );
    const statuses: ChatStatus[] = [];
    await expect(
      connectChat({ clientId: "c", onEvent: () => undefined, onStatus: (s) => statuses.push(s) }),
    ).rejects.toThrow();
    expect(statuses.at(-1)).toMatchObject({ state: "unauthorized" });
    expect(calls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("ticket com 403 (sem escopo chat) para com estado forbidden", async () => {
    setApiKey(TEST_KEY);
    use(http.post("*/api/ws/ticket", () => problem(403, "forbidden_scope")));
    const statuses: ChatStatus[] = [];
    await expect(
      connectChat({ clientId: "c", onEvent: () => undefined, onStatus: (s) => statuses.push(s) }),
    ).rejects.toThrow();
    expect(statuses.at(-1)).toMatchObject({ state: "forbidden" });
  });

  it("close() fecha o socket, limpa timers e silencia callbacks (sem ticket novo)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { tickets, events, opts } = setup();
    const promise = connectChat(opts);
    const socket = await sockets(1);
    socket.serverOpen();
    const conn = await promise;
    const baseline = vi.getTimerCount();
    socket.serverClose(1006); // agenda reconexão
    expect(vi.getTimerCount()).toBe(baseline + 1);
    conn.close();
    expect(vi.getTimerCount()).toBe(baseline);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tickets).toHaveLength(1);
    socket.serverMessage({ type: "agent_started", agent: "insight" });
    expect(events).toHaveLength(0);
  });

  it("abortar o signal durante a busca do ticket cancela: nenhum socket é criado", async () => {
    setApiKey(TEST_KEY);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    let requested = false;
    use(
      http.post("*/api/ws/ticket", async () => {
        requested = true;
        await gate;
        return HttpResponse.json({ ticket: "x".repeat(43), expiresInSeconds: 30 });
      }),
    );
    const ctrl = new AbortController();
    const promise = connectChat({
      clientId: "c",
      onEvent: () => undefined,
      onStatus: () => undefined,
      signal: ctrl.signal,
    });
    const settled = promise.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(requested).toBe(true));
    ctrl.abort();
    release?.();
    expect(await settled).toBe("rejected");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
