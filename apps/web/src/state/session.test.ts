import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_KEY } from "../test/helpers";
import { clearApiKey, getApiKey, maskKey, setApiKey, subscribeApiKey } from "./session";

describe("session", () => {
  afterEach(() => clearApiKey());

  it("guarda a chave só no sessionStorage (nunca no localStorage)", () => {
    setApiKey(TEST_KEY);
    expect(getApiKey()).toBe(TEST_KEY);
    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
    clearApiKey();
    expect(getApiKey()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("segue funcionando (na memória) quando o storage lança em toda operação", () => {
    const boom = () => {
      throw new DOMException("bloqueado", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    expect(getApiKey()).toBeNull();
    expect(() => setApiKey(TEST_KEY)).not.toThrow();
    expect(getApiKey()).toBe(TEST_KEY);
    expect(() => clearApiKey()).not.toThrow();
    expect(getApiKey()).toBeNull();
  });

  it("avisa quem assina quando a chave muda", () => {
    const listener = vi.fn();
    const off = subscribeApiKey(listener);
    setApiKey(TEST_KEY);
    clearApiKey();
    off();
    setApiKey(TEST_KEY);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("maskKey nunca devolve a chave inteira", () => {
    const masked = maskKey(TEST_KEY);
    expect(masked).not.toContain(TEST_KEY);
    expect(masked.length).toBeLessThan(TEST_KEY.length);
    expect(masked.endsWith(TEST_KEY.slice(-4))).toBe(true);
  });
});
