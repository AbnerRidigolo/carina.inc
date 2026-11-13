/**
 * Versão do Node do repositório: uma fonte só (`.nvmrc`), lida pelo CI (`node-version-file`) e
 * repetida no `engines` da raiz e nas imagens dos Dockerfiles. Ela tem de satisfazer todo
 * `engines.node` do lockfile — o CI do PR #12 quebrou com Node 22.12 porque o undici 8 (via
 * jsdom 31, que por sua vez exige ^22.22.2) não carrega num Node antigo e os workers do vitest do
 * web nem subiam.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

type Version = [number, number, number];

/** "22", "22.19", "v12.22.7", "10.x", "6.*" → [maj, min, pat] (curingas viram 0). */
function parse(v: string): Version {
  const [maj = 0, min = 0, pat = 0] = v
    .replace(/^v/, "")
    .split(".")
    .map((n) => (/^\d+$/.test(n) ? Number.parseInt(n, 10) : 0));
  return [maj, min, pat];
}

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Um comparador de faixa do npm (o subconjunto que aparece no lockfile). */
function satisfiesComparator(v: Version, c: string): boolean {
  const m = /^(>=|>|<=|<|\^|~|=)?\s*(v?\d+(?:\.(?:\d+|x|\*)){0,2})$/.exec(c);
  if (!m) throw new Error(`faixa de engines não suportada pelo teste: ${c}`);
  const op = m[1] ?? "";
  const raw = m[2] ?? "0";
  const base = parse(raw);
  const parts = raw.replace(/^v/, "").split(".");
  const wildcard = parts.length < 3 || parts.some((p) => p === "x" || p === "*");
  switch (op) {
    case ">=":
      return cmp(v, base) >= 0;
    case ">":
      return cmp(v, base) > 0;
    case "<=":
      return cmp(v, base) <= 0;
    case "<":
      return cmp(v, base) < 0;
    case "^":
      return v[0] === base[0] && cmp(v, base) >= 0;
    case "~":
      return v[0] === base[0] && v[1] === base[1] && cmp(v, base) >= 0;
    default:
      // "18", "6.*", "10.x": mesma major (e minor, se dada); versão exata se completa.
      if (!wildcard) return cmp(v, base) === 0;
      return (
        v[0] === base[0] && (parts.length < 2 || !/^\d+$/.test(parts[1] ?? "") || v[1] === base[1])
      );
  }
}

function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  return range.split("||").some((alt) =>
    alt
      .trim()
      .replace(/(>=|<=|>|<|\^|~|=)\s+/g, "$1")
      .split(/\s+/)
      .every((c) => satisfiesComparator(v, c)),
  );
}

describe("versão do Node", () => {
  const nvmrc = read(".nvmrc").trim();

  it("o avaliador de faixas cobre os formatos do lockfile", () => {
    expect(satisfies("22.22.2", "^22.22.2 || ^24.15.0 || >=26.0.0")).toBe(true);
    expect(satisfies("22.19.0", "^22.22.2 || ^24.15.0 || >=26.0.0")).toBe(false);
    expect(satisfies("22.12.0", ">=22.19.0")).toBe(false);
    expect(satisfies("22.22.2", ">= 22.22")).toBe(true);
    expect(satisfies("22.22.2", ">=16 || 14 >=14.17")).toBe(true);
    expect(satisfies("22.22.2", "6.* || 8.* || >= 10.*")).toBe(true);
    expect(satisfies("22.22.2", "18 || 20 || >=22")).toBe(true);
    expect(satisfies("22.22.2", ">=v12.22.7")).toBe(true);
  });

  it(".nvmrc fixa uma versão exata (x.y.z)", () => {
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("o .nvmrc satisfaz todo engines.node do lockfile", () => {
    const ranges = [...read("pnpm-lock.yaml").matchAll(/engines: \{[^}]*?node: ('[^']*'|[^,}]*)/g)]
      .map((m) => (m[1] ?? "").replace(/^'|'$/g, "").trim())
      .filter((r) => r !== "");
    expect(ranges.length).toBeGreaterThan(50);
    expect([...new Set(ranges.filter((r) => !satisfies(nvmrc, r)))]).toEqual([]);
  });

  it("engines da raiz e imagens dos Dockerfiles usam a mesma versão do .nvmrc", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${nvmrc}`);
    for (const file of ["apps/api/Dockerfile", "apps/web/Dockerfile"]) {
      const images = [...read(file).matchAll(/node:(\d+\.\d+\.\d+)-/g)].map((m) => m[1]);
      expect(images.length, file).toBeGreaterThan(0);
      expect(new Set(images), file).toEqual(new Set([nvmrc]));
    }
  });
});
