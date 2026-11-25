/**
 * Estratégias declarativas (spec §4, "Dado"): tabela strategy (migração 0010) sob RLS com FORCE por
 * tenant, CHECKs espelhando o StrategySpecSchema, e o StrategyRepository conectado como carina_app
 * (NOBYPASSRLS). Os dados de preparo são gravados como carina_migrator com o tenant fixado.
 * O banco é compartilhado com os outros arquivos int: cada teste usa tenants próprios.
 */
import { randomUUID } from "node:crypto";
import { StrategySchema, type StrategyCreate } from "@carina/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { PrismaService } from "../../src/core/database/prisma.service.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { ValidationError } from "../../src/core/errors/domain-errors.js";
import { StrategyRepository } from "../../src/modules/builder/strategy.repository.js";
import { appUrl, inRlsTransaction, migratorSql, must, withPgClient } from "../setup/db.js";

describe("Estratégias: tabela strategy e StrategyRepository (carina_app, sob RLS)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantCheio = randomUUID();
  const tenantCorrida = randomUUID();
  const tenantTrava = randomUUID();

  let prisma: PrismaService;
  let db: TenantPrismaService;
  let repo: StrategyRepository;

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    TenantContext.run({ tenantId }, fn);

  const create = (tenantId: string, input: StrategyCreate) =>
    inTenant(tenantId, () => db.tx((tx) => repo.create(tx, input)));
  const list = (tenantId: string) => inTenant(tenantId, () => db.tx((tx) => repo.list(tx)));
  const get = (tenantId: string, id: string) =>
    inTenant(tenantId, () => db.tx((tx) => repo.get(tx, id)));

  const smaCross: StrategyCreate = {
    name: "Cruzamento PETR4",
    spec: { kind: "sma_cross", symbol: "PETR4", fast: 5, slow: 20 },
  };

  /** Grava `n` estratégias direto no banco (como dono, com o tenant fixado). */
  const seedMany = (tenantId: string, n: number) =>
    migratorSql(
      `INSERT INTO strategy (tenant_id, name, kind, symbol, fast, slow)
       SELECT $1, 'semente ' || g, 'buy_hold', 'VALE3', 10, 50 FROM generate_series(1, $2) g`,
      [tenantId, n],
      { tenantId },
    );

  const countOf = async (tenantId: string) =>
    Number(
      must(
        (
          await migratorSql<{ n: string }>("SELECT count(*)::text AS n FROM strategy", [], {
            tenantId,
          })
        )[0],
      ).n,
    );

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan) VALUES
         ($1, 'Builder A', 'pro'), ($2, 'Builder B', 'pro'),
         ($3, 'Builder cheio', 'pro'), ($4, 'Builder corrida', 'pro'),
         ($5, 'Builder trava', 'pro')`,
      [tenantA, tenantB, tenantCheio, tenantCorrida, tenantTrava],
    );
    prisma = new PrismaService({ DATABASE_URL: appUrl() });
    db = new TenantPrismaService(prisma);
    repo = new StrategyRepository();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("cria e lê sob o tenant", async () => {
    const created = await create(tenantA, smaCross);
    expect(StrategySchema.parse(created)).toEqual(created);
    expect(created).toMatchObject({
      name: "Cruzamento PETR4",
      spec: { kind: "sma_cross", symbol: "PETR4", fast: 5, slow: 20 },
    });

    expect(await get(tenantA, created.id)).toEqual(created);

    const hold = await create(tenantA, {
      name: "Segurar VALE3",
      spec: { kind: "buy_hold", symbol: "VALE3", fast: 10, slow: 50 },
    });
    // Mais novas primeiro.
    expect((await list(tenantA)).map((s) => s.id)).toEqual([hold.id, created.id]);
  });

  it("tenant B não lê nem lista a estratégia de A", async () => {
    const deA = await create(tenantA, { ...smaCross, name: "Só de A" });

    expect(await get(tenantB, deA.id)).toBeNull();
    expect((await list(tenantB)).map((s) => s.id)).not.toContain(deA.id);
    expect(await list(tenantB)).toEqual([]);

    // Direto no banco: B não vê a linha nem consegue gravar com o tenant_id de A.
    const seen = await withPgClient(appUrl(), (c) =>
      inRlsTransaction(c, { tenantId: tenantB }, () =>
        c.query("SELECT id FROM strategy WHERE id = $1", [deA.id]),
      ),
    );
    expect(seen.rows).toHaveLength(0);
    const forged = withPgClient(appUrl(), (c) =>
      inRlsTransaction(c, { tenantId: tenantB }, () =>
        c.query(
          `INSERT INTO strategy (tenant_id, name, kind, symbol, fast, slow)
           VALUES ($1, 'forjada', 'buy_hold', 'PETR4', 10, 50)`,
          [tenantA],
        ),
      ),
    );
    await expect(forged).rejects.toMatchObject({ code: "42501" });

    // Sem tenant fixado, o carina_app não vê nada.
    const none = await withPgClient(appUrl(), (c) =>
      c.query("SELECT count(*)::int AS n FROM strategy"),
    );
    expect(none.rows[0]).toEqual({ n: 0 });
  });

  it("101ª estratégia → ValidationError", async () => {
    await seedMany(tenantCheio, 99);
    // A 100ª ainda entra.
    await expect(create(tenantCheio, smaCross)).resolves.toMatchObject({ name: smaCross.name });
    expect(await countOf(tenantCheio)).toBe(100);

    const extra = create(tenantCheio, smaCross);
    await expect(extra).rejects.toBeInstanceOf(ValidationError);
    await expect(create(tenantCheio, smaCross)).rejects.toThrow(
      "Limite de 100 estratégias por tenant atingido",
    );
    expect(await countOf(tenantCheio)).toBe(100);

    // O limite é por tenant: outro tenant segue criando.
    await expect(create(tenantB, smaCross)).resolves.toBeDefined();
  });

  it("criações simultâneas com 99 gravadas: só uma entra (limite atômico)", async () => {
    await seedMany(tenantCorrida, 99);
    // Várias ao mesmo tempo (cada uma na sua transação e conexão do pool): sem o lock, mais de uma
    // contaria 99 e gravaria.
    const racers = 8;
    const results = await Promise.allSettled(
      Array.from({ length: racers }, (_, i) =>
        create(tenantCorrida, { ...smaCross, name: `corrida ${String(i + 1)}` }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(racers - 1);
    for (const f of failed) expect(f.reason).toBeInstanceOf(ValidationError);
    expect(await countOf(tenantCorrida)).toBe(100);
  });

  it("criação espera a outra transação do tenant e reconta depois dela (sem janela de corrida)", async () => {
    // Determinístico: uma transação externa toma o mesmo lock do tenant e grava a 100ª SEM
    // confirmar. As criações precisam ESPERAR (aparecem como espera de advisory lock) e, após o
    // COMMIT, recontar e recusar. Sem o lock, elas contariam 99 (o insert externo é invisível) e
    // gravariam todas sem esperar.
    await seedMany(tenantTrava, 99);
    const racers = 3;
    await withPgClient(appUrl(), async (holder) => {
      await holder.query("BEGIN");
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await holder.query("SELECT set_config('app.tenant_id', $1, true)", [tenantTrava]);
        await holder.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
             'strategy_create', $1::text)::text, 0))`,
          [tenantTrava],
        );
        await holder.query(
          `INSERT INTO strategy (tenant_id, name, kind, symbol, fast, slow)
           VALUES ($1, 'externa', 'buy_hold', 'PETR4', 10, 50)`,
          [tenantTrava],
        );
        pending = Promise.allSettled(
          Array.from({ length: racers }, () => create(tenantTrava, smaCross)),
        );
        // Espera as criações ficarem bloqueadas no MESMO lock que esta sessão segura (até ~5 s);
        // outros arquivos int usam advisory locks no mesmo banco, por isso o filtro pela chave.
        let waiting = 0;
        for (let i = 0; i < 100 && waiting < racers; i++) {
          const r = await holder.query<{ n: number }>(
            `SELECT count(*)::int AS n
               FROM pg_locks w
               JOIN pg_locks h
                 ON h.locktype = 'advisory' AND h.pid = pg_backend_pid() AND h.granted
                AND (w.database, w.classid, w.objid, w.objsubid)
                    = (h.database, h.classid, h.objid, h.objsubid)
              WHERE w.locktype = 'advisory' AND NOT w.granted`,
          );
          waiting = must(r.rows[0]).n;
          if (waiting < racers) await new Promise((res) => setTimeout(res, 50));
        }
        expect(waiting).toBe(racers);
        await holder.query("COMMIT");
      } catch (err) {
        await holder.query("ROLLBACK");
        throw err;
      }
      const results = await pending;
      for (const r of results) {
        expect(r.status).toBe("rejected");
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ValidationError);
      }
    });
    expect(await countOf(tenantTrava)).toBe(100);
  });

  it("CHECKs recusam fast >= slow em sma_cross direto no banco", async () => {
    const insert = (kind: string, fast: number, slow: number, name = "direta", symbol = "PETR4") =>
      withPgClient(appUrl(), (c) =>
        inRlsTransaction(c, { tenantId: tenantA }, () =>
          c.query(
            `INSERT INTO strategy (tenant_id, name, kind, symbol, fast, slow)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [tenantA, name, kind, symbol, fast, slow],
          ),
        ),
      );

    await expect(insert("sma_cross", 20, 20)).rejects.toThrow(/strategy_sma_cross_windows_check/);
    await expect(insert("sma_cross", 30, 20)).rejects.toThrow(/strategy_sma_cross_windows_check/);
    // buy_hold ignora as janelas (como no schema): fast >= slow passa.
    await expect(insert("buy_hold", 30, 20)).resolves.toBeDefined();

    // Demais CHECKs espelhando o StrategySpecSchema/StrategyNameSchema.
    await expect(insert("momentum", 5, 20)).rejects.toThrow(/strategy_kind_check/);
    await expect(insert("sma_cross", 1, 20)).rejects.toThrow(/strategy_fast_check/);
    await expect(insert("sma_cross", 201, 300)).rejects.toThrow(/strategy_fast_check/);
    await expect(insert("sma_cross", 2, 401)).rejects.toThrow(/strategy_slow_check/);
    await expect(insert("buy_hold", 2, 2)).rejects.toThrow(/strategy_slow_check/);
    await expect(insert("sma_cross", 5, 20, "")).rejects.toThrow(/strategy_name_check/);
    await expect(insert("sma_cross", 5, 20, "x".repeat(121))).rejects.toThrow(
      /strategy_name_check/,
    );
    await expect(insert("sma_cross", 5, 20, "ok", "petr4")).rejects.toThrow(
      /strategy_symbol_check/,
    );
    await expect(insert("sma_cross", 5, 20, "ok", "PETR4; --")).rejects.toThrow(
      /strategy_symbol_check/,
    );
    // Controle: extremos válidos passam.
    await expect(insert("sma_cross", 2, 3, "x".repeat(120), "^BVSP")).resolves.toBeDefined();
    await expect(insert("sma_cross", 200, 400)).resolves.toBeDefined();
  });

  it("id malformado → null", async () => {
    expect(await get(tenantA, "nao-e-uuid")).toBeNull();
    expect(await get(tenantA, "")).toBeNull();
    expect(await get(tenantA, "1; DROP TABLE strategy")).toBeNull();
    // uuid bem formado e inexistente também → null.
    expect(await get(tenantA, randomUUID())).toBeNull();
  });
});
