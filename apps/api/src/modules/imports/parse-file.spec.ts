import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParseAbortedError, ParseThreadError, parseFile } from "./parse-file.js";
import { PARSE_LIMITS } from "./parsers/types.js";

const fixture = (dir: string, name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(new URL(`../../../test/fixtures/imports/${dir}/${name}`, import.meta.url)),
  );

/** Thread de teste (CommonJS via `eval`) que fica 31 s presa em CPU antes de responder. */
const SLEEPS_31S = {
  filename: `const { parentPort } = require("node:worker_threads");
    const end = Date.now() + 31000;
    while (Date.now() < end) {}
    parentPort.postMessage({ ok: true, result: null });`,
  eval: true,
};

describe("parseFile (parse numa worker thread)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("OFX: o parser roda na thread e devolve o resultado", async () => {
    const bytes = fixture("ofx", "conta-sgml-1252.ofx");
    const r = await parseFile("ofx", bytes, { format: "ofx" }, new AbortController().signal);
    expect(r.failure).toBeUndefined();
    expect(r.transactions).toHaveLength(3);
    expect(r.stats).toMatchObject({ rowsRead: 3, transactions: 3 });
  });

  it("os bytes são transferidos para a thread (o buffer do chamador fica destacado)", async () => {
    const bytes = fixture("ofx", "conta-sgml-1252.ofx");
    const own = new Uint8Array(bytes.byteLength);
    own.set(bytes);
    const done = parseFile("ofx", own, { format: "ofx" }, new AbortController().signal);
    expect(own.byteLength).toBe(0);
    expect((await done).transactions).toHaveLength(3);
  });

  it("CSV com preset e B3 com asOf também são despachados", async () => {
    const csv = await parseFile(
      "csv",
      fixture("csv", "generico-br.csv"),
      { format: "csv", csvPreset: "generico_br", institution: "Banco", account: "cc" },
      new AbortController().signal,
    );
    expect(csv.transactions).toHaveLength(3);
    const b3 = await parseFile(
      "b3_xlsx",
      fixture("xlsx", "b3-posicao.xlsx"),
      { format: "b3_xlsx", asOf: "2025-10-31" },
      new AbortController().signal,
    );
    expect(b3.positions).toHaveLength(6);
    expect(b3.positionInstitutions).toHaveLength(3);
  });

  it("parser que dorme 31 s: a thread é encerrada aos 30 s → limit_exceeded (relógio fake)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = performance.now();
    let settled = false;
    const done = parseFile(
      "ofx",
      new Uint8Array([1]),
      { format: "ofx" },
      new AbortController().signal,
      {
        thread: SLEEPS_31S,
      },
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(PARSE_LIMITS.parseTimeoutMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await done;
    expect(r.failure).toBe("limit_exceeded");
    expect(r.positions).toEqual([]);
    expect(r.transactions).toEqual([]);
    expect(r.stats).toMatchObject({ rowsRead: 0, transactions: 0 });
    // A thread foi derrubada; ninguém esperou os 31 s de verdade.
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("tempo limite injetável", async () => {
    const r = await parseFile(
      "ofx",
      new Uint8Array([1]),
      { format: "ofx" },
      new AbortController().signal,
      {
        thread: SLEEPS_31S,
        timeoutMs: 50,
      },
    );
    expect(r.failure).toBe("limit_exceeded");
  });

  it("abort (worker parando) encerra a thread e rejeita com ParseAbortedError", async () => {
    const abort = new AbortController();
    const done = parseFile("ofx", new Uint8Array([1]), { format: "ofx" }, abort.signal, {
      thread: SLEEPS_31S,
    });
    abort.abort();
    await expect(done).rejects.toBeInstanceOf(ParseAbortedError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      parseFile("ofx", new Uint8Array([1]), { format: "ofx" }, aborted.signal),
    ).rejects.toBeInstanceOf(ParseAbortedError);
  });

  it("erro dentro da thread → ParseThreadError só com o nome do erro (nunca a mensagem)", async () => {
    const throwing = {
      filename: `const { parentPort } = require("node:worker_threads");
        try { throw new TypeError("conteúdo sigiloso da linha"); }
        catch (e) { parentPort.postMessage({ ok: false, error: e.name }); }`,
      eval: true,
    };
    const err = await parseFile(
      "ofx",
      new Uint8Array([1]),
      { format: "ofx" },
      new AbortController().signal,
      {
        thread: throwing,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParseThreadError);
    expect((err as Error).message).toContain("TypeError");
    expect((err as Error).message).not.toContain("sigiloso");

    const crashing = { filename: `throw new RangeError("conteúdo sigiloso");`, eval: true };
    const crash = await parseFile(
      "ofx",
      new Uint8Array([1]),
      { format: "ofx" },
      new AbortController().signal,
      {
        thread: crashing,
      },
    ).catch((e: unknown) => e);
    expect(crash).toBeInstanceOf(ParseThreadError);
    expect((crash as Error).message).not.toContain("sigiloso");

    const silent = { filename: `process.exit(3);`, eval: true };
    await expect(
      parseFile("ofx", new Uint8Array([1]), { format: "ofx" }, new AbortController().signal, {
        thread: silent,
      }),
    ).rejects.toBeInstanceOf(ParseThreadError);
  });
});
