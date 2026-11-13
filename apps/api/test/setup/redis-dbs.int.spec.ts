/**
 * Guarda da alocação de DBs do Redis (test/setup/redis-dbs.ts): números de 0 a 15, únicos dentro
 * de cada projeto do vitest, e todo arquivo de teste que usa um DB do Redis o pega da tabela pelo
 * próprio caminho (nada de número solto que volte a colidir).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REDIS_DBS } from "./redis-dbs.js";

const testRoot = resolve(import.meta.dirname, "..");

function specFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return specFiles(p);
    return /\.(int|e2e)\.spec\.ts$/.test(e.name) ? [relative(testRoot, p)] : [];
  });
}

describe("alocação dos DBs do Redis nos testes", () => {
  it("números entre 0 e 15, únicos dentro de cada projeto", () => {
    for (const [project, table] of Object.entries(REDIS_DBS)) {
      const dbs = Object.values(table);
      expect(
        dbs.every((d) => Number.isInteger(d) && d >= 0 && d <= 15),
        project,
      ).toBe(true);
      expect(new Set(dbs).size, project).toBe(dbs.length);
    }
  });

  it("cada arquivo da tabela existe e está no projeto certo", () => {
    for (const [project, table] of Object.entries(REDIS_DBS)) {
      for (const file of Object.keys(table)) {
        expect(existsSync(join(testRoot, file)), file).toBe(true);
        expect(file.endsWith(`.${project}.spec.ts`), file).toBe(true);
      }
    }
  });

  it("todo arquivo que usa um DB do Redis o pega da tabela pelo próprio caminho", () => {
    const allocated = new Set([...Object.keys(REDIS_DBS.int), ...Object.keys(REDIS_DBS.e2e)]);
    const offenders: string[] = [];
    // Este arquivo só cita os padrões (na regex abaixo); não usa Redis.
    for (const file of specFiles(testRoot).filter((f) => f !== "setup/redis-dbs.int.spec.ts")) {
      const src = readFileSync(join(testRoot, file), "utf8");
      const usesRedisDb = /redisDbUrl\(|redisDb:|createTestApp\(|createApiApp\(|new Redis\(/.test(
        src,
      );
      if (!usesRedisDb) continue;
      const own = src.includes(`redisDbOf("${file}")`);
      const literal = /redisDb:\s*\d|(REDIS_DB|TEST_DB)\s*=\s*\d/.test(src);
      if (!allocated.has(file) || !own || literal) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
