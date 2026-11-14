import { describe, expect, it } from "vitest";
import type { Prisma } from "../../generated/prisma/client.js";
import { KnowledgeRepository, sqlState, toVectorLiteral } from "./knowledge.repository.js";

/** Erro como o Prisma o entrega com o driver adapter do pg. */
function prismaRawError(sqlstate: string): Error {
  return Object.assign(new Error("Raw query failed"), {
    code: "P2010",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: { originalCode: sqlstate, kind: "postgres", code: sqlstate },
      },
    },
  });
}

/** Transação falsa: registra o SQL de cada chamada; `failOn` faz o comando que o contém falhar. */
function fakeTx(failOn?: { match: string; error: Error }) {
  const statements: string[] = [];
  const run = async (strings: TemplateStringsArray) => {
    const sql = strings.join("$").replace(/\s+/g, " ").trim();
    statements.push(sql);
    if (failOn && sql.includes(failOn.match)) throw failOn.error;
    return [];
  };
  const tx = { $executeRaw: run, $queryRaw: run } as unknown as Prisma.TransactionClient;
  return { tx, statements };
}

describe("KnowledgeRepository.enableIterativeScan", () => {
  const repo = new KnowledgeRepository();

  it("aplica o SET dentro de um SAVEPOINT e o libera", async () => {
    const { tx, statements } = fakeTx();
    expect(await repo.enableIterativeScan(tx)).toBe(true);
    expect(statements.slice(1)).toEqual([
      "SAVEPOINT knowledge_iterative_scan",
      "SET LOCAL hnsw.iterative_scan = relaxed_order",
      "RELEASE SAVEPOINT knowledge_iterative_scan",
    ]);
  });

  it.each(["42704", "42602"])(
    "opção desconhecida (%s): volta ao SAVEPOINT e segue",
    async (code) => {
      const { tx, statements } = fakeTx({ match: "SET LOCAL", error: prismaRawError(code) });
      expect(await repo.enableIterativeScan(tx)).toBe(false);
      expect(statements.slice(1)).toEqual([
        "SAVEPOINT knowledge_iterative_scan",
        "SET LOCAL hnsw.iterative_scan = relaxed_order",
        "ROLLBACK TO SAVEPOINT knowledge_iterative_scan",
        "RELEASE SAVEPOINT knowledge_iterative_scan",
      ]);
    },
  );

  it("qualquer outro erro é repassado", async () => {
    const error = prismaRawError("57014");
    const { tx } = fakeTx({ match: "SET LOCAL", error });
    await expect(repo.enableIterativeScan(tx)).rejects.toBe(error);
  });
});

describe("toVectorLiteral", () => {
  it("monta o literal só com números finitos e 1024 dimensões", () => {
    const v = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 0.5 : i === 1 ? -1e-7 : 0));
    const lit = toVectorLiteral(v);
    expect(lit.startsWith("[0.5,-1e-7,0,")).toBe(true);
    expect(lit.endsWith(",0]")).toBe(true);
    expect(lit).toMatch(/^\[[-0-9.e,]+\]$/);
  });

  it("recusa dimensão errada, NaN, Infinity e não-números", () => {
    expect(() => toVectorLiteral([1, 2, 3])).toThrow(/1024/);
    const bad = (x: unknown) => Array.from({ length: 1024 }, (_, i) => (i === 7 ? x : 0));
    expect(() => toVectorLiteral(bad(Number.NaN) as number[])).toThrow();
    expect(() => toVectorLiteral(bad(Number.POSITIVE_INFINITY) as number[])).toThrow();
    expect(() => toVectorLiteral(bad("1]::text; --") as number[])).toThrow();
  });
});

describe("sqlState", () => {
  it("lê o SQLSTATE do erro do Prisma (driver adapter), nunca o código P20xx", () => {
    expect(sqlState(prismaRawError("23503"))).toBe("23503");
    expect(sqlState(Object.assign(new Error("x"), { code: "P2010" }))).toBeUndefined();
  });

  it("lê o SQLSTATE de um erro do pg", () => {
    expect(sqlState(Object.assign(new Error("x"), { code: "42704", severity: "ERROR" }))).toBe(
      "42704",
    );
    expect(sqlState(new Error("x"))).toBeUndefined();
    expect(sqlState(undefined)).toBeUndefined();
  });
});
