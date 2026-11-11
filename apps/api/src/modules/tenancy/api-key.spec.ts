import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./api-key.js";

describe("hashApiKey", () => {
  it("devolve o sha256 em hex (64 caracteres)", () => {
    const hash = hashApiKey("sk-live-abc");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update("sk-live-abc", "utf8").digest("hex"));
  });

  it("é determinístico e distingue chaves diferentes", () => {
    expect(hashApiKey("sk-live-a")).toBe(hashApiKey("sk-live-a"));
    expect(hashApiKey("sk-live-a")).not.toBe(hashApiKey("sk-live-b"));
  });
});

describe("generateApiKey", () => {
  it("gera sk-live- + 32 caracteres base62, com hash e prefixo coerentes", () => {
    const { key, hash, prefix } = generateApiKey();
    expect(key).toMatch(/^sk-live-[0-9A-Za-z]{32}$/);
    expect(prefix.startsWith("sk-live-")).toBe(true);
    expect(prefix).toBe(key.slice(0, 12));
    expect(hash).toBe(hashApiKey(key));
  });

  it("duas chaves geradas são diferentes", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.hash).not.toBe(b.hash);
  });

  it("usa todo o alfabeto base62 ao longo de muitas chaves", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) for (const ch of generateApiKey().key.slice(8)) seen.add(ch);
    expect(seen.size).toBe(62);
  });
});
