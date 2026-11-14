import { HttpResponse, http } from "msw";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { setApiKey } from "../state/session";
import { TEST_KEY, problem, use } from "../test/helpers";
import { ApiProblemError, ApiValidationError, apiFetch, onUnauthorized } from "./client";

const Schema = z.object({ n: z.number() });

describe("apiFetch", () => {
  it("valida a resposta com o schema e manda a chave só no header Authorization", async () => {
    setApiKey(TEST_KEY);
    let seen: { auth: string | null; url: string } | undefined;
    use(
      http.get("*/api/x", ({ request }) => {
        seen = { auth: request.headers.get("authorization"), url: request.url };
        return HttpResponse.json({ n: 1 });
      }),
    );
    await expect(apiFetch("/api/x", Schema)).resolves.toEqual({ n: 1 });
    expect(seen?.auth).toBe(`Bearer ${TEST_KEY}`);
    expect(seen?.url).not.toContain(TEST_KEY);
    expect(seen?.url).not.toContain("sk-live");
  });

  it("resposta fora do schema lança erro em vez de devolver o dado", async () => {
    setApiKey(TEST_KEY);
    use(http.get("*/api/x", () => HttpResponse.json({ n: "não é número", segredo: "zzz" })));
    const err = await apiFetch("/api/x", Schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiValidationError);
    expect((err as Error).message).not.toContain("zzz");
  });

  it("converte um Problem (RFC 9457) em ApiProblemError com código e Retry-After", async () => {
    setApiKey(TEST_KEY);
    use(http.get("*/api/x", () => problem(429, "rate_limited", { "Retry-After": "7" })));
    const err = await apiFetch("/api/x", Schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblemError);
    expect(err).toMatchObject({
      status: 429,
      code: "rate_limited",
      traceId: "trace-1",
      retryAfterSeconds: 7,
    });
  });

  it("erro sem corpo Problem (ex.: 502 do proxy) vira ApiProblemError genérico", async () => {
    setApiKey(TEST_KEY);
    use(http.get("*/api/x", () => new HttpResponse("<html>bad gateway</html>", { status: 502 })));
    const err = await apiFetch("/api/x", Schema).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "http_502" });
    expect((err as Error).message).not.toContain("html");
  });

  it("um 401 avisa os assinantes (chave inválida/expirada), exceto com chave explícita", async () => {
    setApiKey(TEST_KEY);
    use(http.get("*/api/x", () => problem(401, "unauthenticated")));
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    await apiFetch("/api/x", Schema).catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    await apiFetch("/api/x", Schema, { apiKey: TEST_KEY }).catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("recusa caminhos que não sejam /api/ (a chave não vai para outra origem)", async () => {
    setApiKey(TEST_KEY);
    await expect(apiFetch("https://evil.example/api/x", Schema)).rejects.toThrow();
    await expect(apiFetch("//evil.example/api/x", Schema)).rejects.toThrow();
  });

  it("envia o corpo JSON em POST", async () => {
    setApiKey(TEST_KEY);
    let body: unknown;
    use(
      http.post("*/api/x", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ n: 2 });
      }),
    );
    await apiFetch("/api/x", Schema, { method: "POST", body: { a: 1 } });
    expect(body).toEqual({ a: 1 });
  });
});
