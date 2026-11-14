import { describe, expect, it, vi } from "vitest";
import { MarketDataUnavailableError } from "../../../core/errors/domain-errors.js";
import {
  buildProviderUrl,
  safeFetchJson,
  withNetworkRetry,
  type MarketLogger,
} from "./safe-fetch.js";

const URL_OK = new URL("https://provider.example/api/quote/PETR4?range=5d");

function logger() {
  const warn = vi.fn<MarketLogger["warn"]>();
  return { warn, log: { warn } satisfies MarketLogger };
}

function opts(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof safeFetchJson>[1]> = {}) {
  return { fetchImpl, timeoutMs: 1000, maxBytes: 1024, logger: logger().log, ...extra };
}

const jsonResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });

/** Corpo em fluxo sem fim (1 KiB por leitura) que conta leituras e registra o cancelamento. */
function endlessStream() {
  const state = { pulls: 0, cancelled: false };
  const chunk = new Uint8Array(1024).fill(0x20);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** `fetch` falso que só termina quando o sinal aborta (servidor que nunca responde). */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(init.signal?.reason as Error);
    });
  });

describe("safeFetchJson", () => {
  it("devolve o JSON e chama fetch com GET, redirect error, sinal e cabeçalhos", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse('{"ok":true}')));
    const out = await safeFetchJson(URL_OK, opts(fetchImpl, { headers: { Authorization: "x" } }));
    expect(out).toEqual({ ok: true });
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(input)).toBe(URL_OK.href);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({ Authorization: "x", Accept: "application/json" });
  });

  it("status fora de 2xx lança, cancela o corpo e registra só o host e o status", async () => {
    const { stream, state } = endlessStream();
    const { warn, log } = logger();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(stream, { status: 500 })),
    );
    await expect(safeFetchJson(URL_OK, opts(fetchImpl, { logger: log }))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    expect(state.cancelled).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]?.[0];
    expect(fields).toMatchObject({ host: "provider.example", status: 500 });
    expect(JSON.stringify(fields)).not.toContain("/api/quote");
    expect(JSON.stringify(fields)).not.toContain("range=");
  });

  it.each([301, 302, 404, 429])("status %i lança MarketDataUnavailableError", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, { status, headers: { location: "https://evil.example" } }),
      ),
    );
    await expect(safeFetchJson(URL_OK, opts(fetchImpl))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
  });

  it("JSON inválido lança e o log não carrega o corpo", async () => {
    const { warn, log } = logger();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse("<html>segredo-do-provedor</html>")),
    );
    await expect(safeFetchJson(URL_OK, opts(fetchImpl, { logger: log }))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    const logged = warn.mock.calls[0]?.[0];
    const err = logged?.err as Error;
    expect(`${JSON.stringify(logged)} ${err.message} ${String(err.stack)}`).not.toContain(
      "segredo-do-provedor",
    );
  });

  it("corpo vazio lança", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null)));
    await expect(safeFetchJson(URL_OK, opts(fetchImpl))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
  });

  it("UTF-8 inválido lança", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([0x22, 0xff, 0xfe, 0x22]))),
    );
    await expect(safeFetchJson(URL_OK, opts(fetchImpl))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
  });

  it("Content-Length acima do limite lança sem ler o corpo", async () => {
    const { stream, state } = endlessStream();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(stream, { headers: { "content-length": "999999" } })),
    );
    await expect(safeFetchJson(URL_OK, opts(fetchImpl))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(1);
  });

  it("corpo em fluxo acima do limite para de ler e cancela o leitor", async () => {
    const { stream, state } = endlessStream();
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(stream)));
    await expect(safeFetchJson(URL_OK, opts(fetchImpl, { maxBytes: 4096 }))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    expect(state.cancelled).toBe(true);
    // 4 KiB de limite, 1 KiB por leitura: nunca lê muito além do limite.
    expect(state.pulls).toBeLessThanOrEqual(8);
  });

  it("corpo exatamente no limite é aceito", async () => {
    const body = `"${"a".repeat(1022)}"`;
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(body)));
    await expect(safeFetchJson(URL_OK, opts(fetchImpl, { maxBytes: 1024 }))).resolves.toBe(
      "a".repeat(1022),
    );
  });

  it("servidor que não responde estoura o prazo e lança", async () => {
    const started = Date.now();
    await expect(
      safeFetchJson(URL_OK, opts(hangingFetch, { timeoutMs: 20 })),
    ).rejects.toBeInstanceOf(MarketDataUnavailableError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("corpo que trava no meio da leitura estoura o prazo e lança", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(stalled)));
    await expect(safeFetchJson(URL_OK, opts(fetchImpl, { timeoutMs: 20 }))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    expect(cancelled).toBe(true);
  });

  it("erro de rede lança e o log leva só nome e código, sem a URL", async () => {
    const { warn, log } = logger();
    const netErr = new TypeError(`fetch failed ${URL_OK.href}`, {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(netErr));
    await expect(safeFetchJson(URL_OK, opts(fetchImpl, { logger: log }))).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
    const logged = warn.mock.calls[0]?.[0];
    const err = logged?.err as Error;
    expect(logged?.host).toBe("provider.example");
    expect(err.message).toContain("ENOTFOUND");
    expect(`${JSON.stringify(logged)} ${err.message} ${String(err.stack)}`).not.toContain(
      "/api/quote",
    );
  });

  it.each(["ftp://provider.example/x", "file:///etc/passwd", "https://u:p@provider.example/x"])(
    "recusa %s sem chamar fetch",
    async (raw) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(safeFetchJson(new URL(raw), opts(fetchImpl))).rejects.toBeInstanceOf(
        MarketDataUnavailableError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe("withNetworkRetry", () => {
  it("tenta de novo uma única vez em erro de rede", async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse("1"));
    const res = await withNetworkRetry(inner)("https://provider.example/x");
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("não passa de uma tentativa extra", async () => {
    const inner = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(withNetworkRetry(inner)("https://provider.example/x")).rejects.toThrow(
      "fetch failed",
    );
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("não repete resposta HTTP com erro nem aborto por prazo", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    expect((await withNetworkRetry(http)("https://provider.example/x")).status).toBe(503);
    expect(http).toHaveBeenCalledTimes(1);

    const signal = AbortSignal.abort(new DOMException("prazo", "TimeoutError"));
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(signal.reason);
    await expect(
      withNetworkRetry(aborted)("https://provider.example/x", { signal }),
    ).rejects.toBeDefined();
    expect(aborted).toHaveBeenCalledTimes(1);
  });
});

describe("buildProviderUrl", () => {
  it("anexa segmentos codificados ao caminho da base e monta a query", () => {
    expect(buildProviderUrl("https://brapi.dev/api", ["quote", "^BVSP"]).href).toBe(
      "https://brapi.dev/api/quote/%5EBVSP",
    );
    expect(
      buildProviderUrl("https://brapi.dev/api/", ["quote", "PETR4"], { range: "5d" }).href,
    ).toBe("https://brapi.dev/api/quote/PETR4?range=5d");
  });

  it("descarta query e fragmento da base", () => {
    expect(buildProviderUrl("https://h.example/a?token=x#f", ["b"]).href).toBe(
      "https://h.example/a/b",
    );
  });

  it.each([[[".."]], [["."]], [[""]], [["a/../../x"]]])("nunca sai da base (%j)", (segments) => {
    let url: URL | undefined;
    try {
      url = buildProviderUrl("https://brapi.dev/api", segments);
    } catch (err) {
      expect(err).toBeInstanceOf(MarketDataUnavailableError);
      return;
    }
    expect(url.origin).toBe("https://brapi.dev");
    expect(url.pathname.startsWith("/api/")).toBe(true);
    expect(url.pathname).not.toContain("/../");
  });
});
