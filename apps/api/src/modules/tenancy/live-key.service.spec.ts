import { describe, expect, it, vi } from "vitest";
import { LiveKeyService } from "./live-key.service.js";

const KEY = "aaaaaaaa-1111-4111-8111-11111111111b";
const row = {
  key_id: KEY,
  tenant_id: "bbbbbbbb-2222-4222-8222-22222222222c",
  tenant_name: "T",
  scopes: ["chat"],
  rpm: 60,
  monthly_quota: 10,
};

function make(ttlMs: number, rows: unknown[][]) {
  let now = 1_000;
  const $queryRaw = vi.fn(() => Promise.resolve(rows.shift() ?? []));
  const svc = new LiveKeyService(
    { $queryRaw } as never,
    { API_KEY_REVALIDATE_TTL_MS: ttlMs },
    () => now,
  );
  return { svc, $queryRaw, advance: (ms: number) => (now += ms) };
}

describe("LiveKeyService", () => {
  it("dentro do TTL usa o cache; vencido, consulta de novo e vê a revogação", async () => {
    const { svc, $queryRaw, advance } = make(60_000, [[row], []]);
    expect((await svc.resolve(KEY))?.scopes).toEqual(["chat"]);
    advance(59_999);
    expect(await svc.resolve(KEY)).not.toBeNull();
    expect($queryRaw).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await svc.resolve(KEY)).toBeNull(); // revogada: a mudança vale no máximo 60 s depois
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it("TTL 0: sempre consulta", async () => {
    const { svc, $queryRaw } = make(0, [[row], [row]]);
    await svc.resolve(KEY);
    await svc.resolve(KEY);
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it("id que não é uuid: null sem consultar o banco", async () => {
    const { svc, $queryRaw } = make(60_000, []);
    expect(await svc.resolve("x' OR 1=1")).toBeNull();
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
