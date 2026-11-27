/**
 * AOPs (spec §4.3–4.4): tabelas aop e aop_run (migração 0011) sob RLS com FORCE por tenant, CHECKs
 * espelhando o AopSchema/AopRunSchema, a função `aop_tenant_ids()` (SECURITY DEFINER) e o
 * AopsRepository conectado como carina_app (NOBYPASSRLS). Os dados de preparo são gravados como
 * carina_migrator com o tenant fixado. O banco é compartilhado com os outros arquivos int: cada teste
 * usa tenants próprios, e as asserções sobre `tenantIds` olham só os tenants deste arquivo.
 */
import { randomUUID } from "node:crypto";
import { AopRunSchema, AopSchema, WorkTypeSchema, type AopRun } from "@carina/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { PrismaService } from "../../src/core/database/prisma.service.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { ValidationError } from "../../src/core/errors/domain-errors.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import {
  AopsRepository,
  type NewAop,
  type NewAopRun,
} from "../../src/modules/aops/aops.repository.js";
import { appUrl, inRlsTransaction, migratorSql, must, withPgClient } from "../setup/db.js";

describe("AOPs: tabelas aop/aop_run e AopsRepository (carina_app, sob RLS)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantCheio = randomUUID();
  const tenantCorrida = randomUUID();
  const tenantSuspenso = randomUUID();
  const tenantDesligado = randomUUID();
  const clientA1 = randomUUID();
  const clientA2 = randomUUID();
  const clientB1 = randomUUID();

  let prisma: PrismaService;
  let db: TenantPrismaService;
  let repo: AopsRepository;

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    TenantContext.run({ tenantId }, fn);
  const inTx = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    inTenant(tenantId, () => db.tx(fn));

  /** Relógio dos testes: quarta, 7/1/2026. O último horário semanal de sexta 9h é 2/1, 12:00Z. */
  const NOW = Date.parse("2026-01-07T15:00:00.000Z");
  const PREVIOUS_FRIDAY = "2026-01-02T12:00:00.000Z";

  const create = (tenantId: string, input: NewAop = aopInput()) =>
    inTx(tenantId, (tx) => repo.create(tx, input, NOW));
  const get = (tenantId: string, id: string) => inTx(tenantId, (tx) => repo.get(tx, id));
  const list = (tenantId: string) => inTx(tenantId, (tx) => repo.list(tx));
  const claim = (tenantId: string, id: string, fireAt: Date) =>
    inTx(tenantId, (tx) => repo.claimFire(tx, id, fireAt));
  const setEnabled = (tenantId: string, id: string, enabled: boolean) =>
    inTx(tenantId, (tx) => repo.setEnabled(tx, id, enabled, NOW));
  const insertRun = (tenantId: string, run: NewAopRun) =>
    inTx(tenantId, (tx) => repo.insertRun(tx, run));
  const listRuns = (tenantId: string, aopId: string, cursor: string | null, limit: number) =>
    inTx(tenantId, (tx) => repo.listRuns(tx, aopId, cursor, limit));

  function aopInput(over: Partial<NewAop> = {}): NewAop {
    return {
      name: "Carteira premium",
      description: "Toda sexta às 9h, analise a carteira e o risco dos clientes premium",
      agents: ["insight", "risk"],
      schedule: { frequency: "weekly", weekday: 4, day: 1, hour: 9 },
      clientIds: ["a1", "a2"],
      ...over,
    };
  }

  function runInput(aopId: string, over: Partial<NewAopRun> = {}): NewAopRun {
    return {
      aopId,
      clientId: clientA1,
      fireAt: new Date("2026-11-27T12:00:00.000Z"),
      trigger: "schedule",
      status: "ok",
      failureCode: null,
      results: { insight: { summary: "ok" }, risk: { failed: true } },
      workType: "multi_agent_analysis",
      priceBrl: "4.90",
      auditId: randomUUID(),
      ...over,
    };
  }

  /** Grava `n` AOPs direto no banco (como dono, com o tenant fixado). */
  const seedMany = (tenantId: string, n: number, enabled = true) =>
    migratorSql(
      `INSERT INTO aop (tenant_id, name, description, agents, frequency, weekday, day, hour,
                        client_ids, enabled)
       SELECT $1, 'semente ' || g, 'descrição', ARRAY['insight'], 'daily', 0, 1, 9,
              ARRAY['x'], $3
         FROM generate_series(1, $2) g`,
      [tenantId, n, enabled],
      { tenantId },
    );

  const countOf = async (table: "aop" | "aop_run", tenantId: string, where = "TRUE") =>
    Number(
      must(
        (
          await migratorSql<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
            [],
            { tenantId },
          )
        )[0],
      ).n,
    );

  /** SQL como carina_app com o tenant fixado (direto no banco, sem o repositório). */
  const asApp = (tenantId: string, sql: string, params: unknown[] = []) =>
    withPgClient(appUrl(), (c) => inRlsTransaction(c, { tenantId }, () => c.query(sql, params)));

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan, suspended_at) VALUES
         ($1, 'AOP A', 'pro', NULL), ($2, 'AOP B', 'pro', NULL), ($3, 'AOP cheio', 'pro', NULL),
         ($4, 'AOP corrida', 'pro', NULL), ($5, 'AOP suspenso', 'pro', now()),
         ($6, 'AOP desligado', 'pro', NULL)`,
      [tenantA, tenantB, tenantCheio, tenantCorrida, tenantSuspenso, tenantDesligado],
    );
    const client = (tenantId: string, id: string, ext: string) =>
      migratorSql(
        `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, $3)`,
        [id, tenantId, ext],
        { tenantId },
      );
    await client(tenantA, clientA1, "a1");
    await client(tenantA, clientA2, "a2");
    await client(tenantB, clientB1, "b1");
    // Suspenso com AOP habilitado; desligado só com AOP desabilitado: nenhum dos dois é varrido.
    await seedMany(tenantSuspenso, 1, true);
    await seedMany(tenantDesligado, 2, false);

    prisma = new PrismaService({ DATABASE_URL: appUrl() });
    db = new TenantPrismaService(prisma);
    repo = new AopsRepository(db);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("cria e lê sob o tenant; outro tenant não vê", async () => {
    const created = await create(tenantA);
    expect(AopSchema.parse(created)).toEqual(created);
    expect(created).toMatchObject({
      name: "Carteira premium",
      agents: ["insight", "risk"],
      schedule: { frequency: "weekly", weekday: 4, day: 1, hour: 9 },
      clientIds: ["a1", "a2"],
      enabled: true,
      // O primeiro disparo é o próximo horário: nasce com o último que já passou.
      lastFireAt: PREVIOUS_FRIDAY,
    });
    expect(await get(tenantA, created.id)).toEqual(created);

    const daily = await create(
      tenantA,
      aopInput({ name: "Diário", schedule: { frequency: "daily", weekday: 0, day: 1, hour: 7 } }),
    );
    // Mais novos primeiro.
    const ids = (await list(tenantA)).map((a) => a.id);
    expect(ids.indexOf(daily.id)).toBeLessThan(ids.indexOf(created.id));

    // B não lê, não lista, não liga/desliga nem dispara o AOP de A.
    expect(await get(tenantB, created.id)).toBeNull();
    expect(await list(tenantB)).toEqual([]);
    expect(await setEnabled(tenantB, created.id, false)).toBeNull();
    expect(await claim(tenantB, created.id, new Date())).toBe(false);
    expect((await get(tenantA, created.id))?.enabled).toBe(true);

    // Direto no banco: B não vê a linha nem grava com o tenant_id de A.
    expect((await asApp(tenantB, "SELECT id FROM aop WHERE id = $1", [created.id])).rows).toEqual(
      [],
    );
    await expect(
      asApp(
        tenantB,
        `INSERT INTO aop (tenant_id, name, description, agents, frequency, weekday, day, hour,
                          client_ids)
         VALUES ($1, 'forjado', 'd', ARRAY['insight'], 'daily', 0, 1, 9, ARRAY['x'])`,
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    // Sem tenant fixado, o carina_app não vê nada.
    const none = await withPgClient(appUrl(), (c) =>
      c.query("SELECT (SELECT count(*)::int FROM aop) + (SELECT count(*)::int FROM aop_run) AS n"),
    );
    expect(none.rows[0]).toEqual({ n: 0 });
  });

  it("id malformado → null (get, setEnabled) e false (claimFire)", async () => {
    for (const bad of ["nao-e-uuid", "", "1; DROP TABLE aop"]) {
      expect(await get(tenantA, bad)).toBeNull();
      expect(await setEnabled(tenantA, bad, false)).toBeNull();
      expect(await claim(tenantA, bad, new Date())).toBe(false);
    }
    expect(await get(tenantA, randomUUID())).toBeNull();
  });

  it("51º AOP → ValidationError", async () => {
    await seedMany(tenantCheio, 49);
    // O 50º ainda entra.
    await expect(create(tenantCheio)).resolves.toMatchObject({ name: "Carteira premium" });
    expect(await countOf("aop", tenantCheio)).toBe(50);

    await expect(create(tenantCheio)).rejects.toBeInstanceOf(ValidationError);
    await expect(create(tenantCheio)).rejects.toThrow("Limite de 50 AOPs por tenant atingido");
    expect(await countOf("aop", tenantCheio)).toBe(50);

    // O limite conta também os desligados, e é por tenant.
    await expect(create(tenantB, aopInput({ clientIds: ["b1"] }))).resolves.toBeDefined();
  });

  it("criações simultâneas com 49 gravados: só uma entra (limite atômico)", async () => {
    await seedMany(tenantCorrida, 49);
    const racers = 6;
    const results = await Promise.allSettled(
      Array.from({ length: racers }, (_, i) =>
        create(tenantCorrida, aopInput({ name: `corrida ${String(i + 1)}` })),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failed).toHaveLength(racers - 1);
    for (const f of failed) expect(f.reason).toBeInstanceOf(ValidationError);
    expect(await countOf("aop", tenantCorrida)).toBe(50);
  });

  it("claimFire: só o primeiro de dois concorrentes ganha", async () => {
    const aop = await create(tenantA);
    const fireAt = new Date("2026-11-27T12:00:00.000Z");
    // Cada disparo na sua transação e conexão do pool, como réplicas do worker.
    const racers = 6;
    const results = await Promise.all(
      Array.from({ length: racers }, () => claim(tenantA, aop.id, fireAt)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await get(tenantA, aop.id))?.lastFireAt).toBe(fireAt.toISOString());
  });

  it("claimFire não dispara AOP desligado nem o mesmo fire_at de novo", async () => {
    const aop = await create(tenantA);
    const t0 = new Date("2026-11-20T12:00:00.000Z");
    const t1 = new Date("2026-11-27T12:00:00.000Z");
    const t2 = new Date("2026-12-04T12:00:00.000Z");
    const t3 = new Date("2026-12-11T12:00:00.000Z");

    expect(await claim(tenantA, aop.id, t1)).toBe(true);
    expect(await claim(tenantA, aop.id, t1)).toBe(false);
    // Horário anterior ao último disparo também não.
    expect(await claim(tenantA, aop.id, t0)).toBe(false);
    expect(await claim(tenantA, aop.id, t2)).toBe(true);

    const off = must(await setEnabled(tenantA, aop.id, false));
    expect(off).toMatchObject({ enabled: false, lastFireAt: t2.toISOString() });
    expect(await claim(tenantA, aop.id, t3)).toBe(false);
    expect((await get(tenantA, aop.id))?.lastFireAt).toBe(t2.toISOString());

    expect(await setEnabled(tenantA, aop.id, true)).toMatchObject({ enabled: true });
    expect(await claim(tenantA, aop.id, t3)).toBe(true);
  });

  it("dueAops traz só os habilitados do tenant", async () => {
    const on = await create(tenantB, aopInput({ name: "ligado", clientIds: ["b1"] }));
    const off = await create(tenantB, aopInput({ name: "desligado", clientIds: ["b1"] }));
    await setEnabled(tenantB, off.id, false);
    const due = await inTx(tenantB, (tx) => repo.dueAops(tx));
    const ids = due.map((a) => a.id);
    expect(ids).toContain(on.id);
    expect(ids).not.toContain(off.id);
    for (const a of due) expect(a.enabled).toBe(true);
    // Nada de outro tenant.
    expect(await inTx(tenantDesligado, (tx) => repo.dueAops(tx))).toEqual([]);
  });

  it("insertRun idempotente", async () => {
    const aop = await create(tenantA);
    const first = must(await insertRun(tenantA, runInput(aop.id)), "execução gravada");
    expect(AopRunSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      aopId: aop.id,
      clientId: "a1",
      fireAt: "2026-11-27T12:00:00.000Z",
      trigger: "schedule",
      status: "ok",
      failureCode: null,
      results: { insight: { summary: "ok" }, risk: { failed: true } },
      workType: "multi_agent_analysis",
      priceBrl: "4.90",
    });

    // Mesmo (aop, cliente, fire_at), outro conteúdo: nada muda.
    expect(
      await insertRun(
        tenantA,
        runInput(aop.id, {
          status: "failed",
          failureCode: "agents_failed",
          workType: null,
          priceBrl: null,
        }),
      ),
    ).toBeNull();
    expect(await countOf("aop_run", tenantA, `aop_id = '${aop.id}'`)).toBe(1);

    // Outro cliente no mesmo horário grava; pulado sem cobrança (work_type e preço nulos).
    const skipped = must(
      await insertRun(
        tenantA,
        runInput(aop.id, {
          clientId: clientA2,
          trigger: "manual",
          status: "skipped",
          failureCode: "quota_exceeded",
          results: {},
          workType: null,
          priceBrl: null,
          auditId: null,
        }),
      ),
    );
    expect(AopRunSchema.parse(skipped)).toEqual(skipped);
    expect(skipped).toMatchObject({
      clientId: "a2",
      status: "skipped",
      failureCode: "quota_exceeded",
      workType: null,
      priceBrl: null,
    });
  });

  it("listRuns pagina do mais novo", async () => {
    const aop = await create(tenantA);
    const other = await create(tenantA);
    const inserted: AopRun[] = [];
    for (let i = 0; i < 5; i++) {
      inserted.push(
        must(
          await insertRun(
            tenantA,
            runInput(aop.id, { fireAt: new Date(Date.UTC(2026, 10, 1 + i, 12)) }),
          ),
        ),
      );
    }
    // Execução de outro AOP do mesmo tenant não entra.
    await insertRun(tenantA, runInput(other.id));

    const newestFirst = [...inserted].reverse();
    const p1 = await listRuns(tenantA, aop.id, null, 2);
    expect(p1.items).toEqual(newestFirst.slice(0, 2));
    const p2 = await listRuns(tenantA, aop.id, must(p1.nextCursor, "cursor da página 1"), 2);
    expect(p2.items).toEqual(newestFirst.slice(2, 4));
    const p3 = await listRuns(tenantA, aop.id, must(p2.nextCursor, "cursor da página 2"), 2);
    expect(p3).toEqual({ items: newestFirst.slice(4), nextCursor: null });
    expect((await listRuns(tenantA, aop.id, null, 5)).nextCursor).toBeNull();

    // Outro tenant e id malformado: página vazia.
    expect(await listRuns(tenantB, aop.id, null, 50)).toEqual({ items: [], nextCursor: null });
    expect(await listRuns(tenantA, "nao-e-uuid", null, 50)).toEqual({
      items: [],
      nextCursor: null,
    });
    // Cursor inválido → ValidationError.
    for (const bad of ["xyz", "", Buffer.from("nada|aqui").toString("base64url")]) {
      await expect(listRuns(tenantA, aop.id, bad, 10)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("apagar cliente apaga as execuções dele (cascade)", async () => {
    const clientA3 = randomUUID();
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, 'a3')`,
      [clientA3, tenantA],
      { tenantId: tenantA },
    );
    const aop = await create(tenantA);
    await insertRun(tenantA, runInput(aop.id, { clientId: clientA3 }));
    await insertRun(tenantA, runInput(aop.id, { clientId: clientA1 }));
    expect(await countOf("aop_run", tenantA, `aop_id = '${aop.id}'`)).toBe(2);

    // Como carina_app, sob o tenant.
    await asApp(tenantA, "DELETE FROM client WHERE id = $1", [clientA3]);
    expect(await countOf("aop_run", tenantA, `client_id = '${clientA3}'`)).toBe(0);
    expect(await countOf("aop_run", tenantA, `aop_id = '${aop.id}'`)).toBe(1);

    // Apagar o AOP (como dono: carina_app não apaga AOP) apaga as execuções dele.
    await migratorSql("DELETE FROM aop WHERE id = $1", [aop.id], { tenantId: tenantA });
    expect(await countOf("aop_run", tenantA, `aop_id = '${aop.id}'`)).toBe(0);
  });

  it("aop_run sob RLS: B não lê nem grava execução no AOP ou cliente de A", async () => {
    const aop = await create(tenantA);
    await insertRun(tenantA, runInput(aop.id));
    expect(
      (await asApp(tenantB, "SELECT id FROM aop_run WHERE aop_id = $1", [aop.id])).rows,
    ).toEqual([]);

    const forge = (tenantId: string, aopId: string, clientId: string) =>
      asApp(
        tenantB,
        `INSERT INTO aop_run (tenant_id, aop_id, client_id, fire_at, trigger, status,
                              failure_code, results)
         VALUES ($1, $2, $3, now(), 'manual', 'skipped', 'client_not_found', '{}')`,
        [tenantId, aopId, clientId],
      ).then(
        () => null,
        (err: unknown) => err,
      );
    // Com o tenant_id de A: a política recusa.
    expect(await forge(tenantA, aop.id, clientA1)).toMatchObject({ code: "42501" });
    // Com o próprio tenant_id e o AOP de A: a FK composta recusa.
    const b = await create(tenantB, aopInput({ clientIds: ["b1"] }));
    expect(await forge(tenantB, aop.id, clientB1)).toMatchObject({ code: "23503" });
    // Com o próprio AOP e o cliente de A: idem.
    expect(await forge(tenantB, b.id, clientA1)).toMatchObject({ code: "23503" });
    // Controle: com o próprio AOP e cliente, grava.
    await expect(
      asApp(
        tenantB,
        `INSERT INTO aop_run (tenant_id, aop_id, client_id, fire_at, trigger, status,
                              failure_code, results)
         VALUES ($1, $2, $3, now(), 'manual', 'skipped', 'client_not_found', '{}')`,
        [tenantB, b.id, clientB1],
      ),
    ).resolves.toBeDefined();
  });

  it("carina_app só altera enabled e last_fire_at; aop_run não muda depois de gravada", async () => {
    const aop = await create(tenantA);
    await insertRun(tenantA, runInput(aop.id));
    const denied = [
      ["UPDATE aop SET name = 'outro' WHERE id = $1", [aop.id]],
      ["UPDATE aop SET agents = ARRAY['tax'] WHERE id = $1", [aop.id]],
      ["DELETE FROM aop WHERE id = $1", [aop.id]],
      ["UPDATE aop_run SET status = 'failed' WHERE aop_id = $1", [aop.id]],
      ["DELETE FROM aop_run WHERE aop_id = $1", [aop.id]],
    ] as const;
    for (const [sql, params] of denied) {
      await expect(asApp(tenantA, sql, [...params])).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      asApp(tenantA, "UPDATE aop SET enabled = false, last_fire_at = now() WHERE id = $1", [
        aop.id,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("aop_tenant_ids ignora tenant suspenso e sem AOP habilitado", async () => {
    const ids = await repo.tenantIds();
    expect(ids).toContain(tenantA);
    expect(ids).toContain(tenantB);
    expect(ids).not.toContain(tenantSuspenso);
    expect(ids).not.toContain(tenantDesligado);
    expect(new Set(ids).size).toBe(ids.length);

    const [fn] = await migratorSql<{
      secdef: boolean;
      owner: string;
      public_exec: boolean;
      app_exec: boolean;
      config: string[];
    }>(
      `SELECT p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('carina_app', p.oid, 'EXECUTE') AS app_exec,
              p.proconfig AS config
         FROM pg_proc p WHERE p.proname = 'aop_tenant_ids'`,
    );
    expect(fn).toEqual({
      secdef: true,
      owner: "carina_migrator",
      public_exec: false,
      app_exec: true,
      config: ["search_path=public, pg_temp"],
    });
  });

  it("CHECKs de aop recusam valores fora do AopSchema direto no banco", async () => {
    const base = {
      name: "direto",
      description: "d",
      agents: ["insight"],
      frequency: "weekly",
      weekday: 4,
      day: 1,
      hour: 9,
      clientIds: ["a1"],
    };
    const insert = (over: Partial<typeof base>) => {
      const v = { ...base, ...over };
      return asApp(
        tenantA,
        `INSERT INTO aop (tenant_id, name, description, agents, frequency, weekday, day, hour,
                          client_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantA,
          v.name,
          v.description,
          v.agents,
          v.frequency,
          v.weekday,
          v.day,
          v.hour,
          v.clientIds,
        ],
      );
    };

    await expect(insert({ name: "" })).rejects.toThrow(/aop_name_check/);
    await expect(insert({ name: "x".repeat(121) })).rejects.toThrow(/aop_name_check/);
    await expect(insert({ description: "" })).rejects.toThrow(/aop_description_check/);
    await expect(insert({ description: "x".repeat(2001) })).rejects.toThrow(
      /aop_description_check/,
    );
    await expect(insert({ agents: [] })).rejects.toThrow(/aop_agents_check/);
    await expect(insert({ agents: ["insight", "risk", "tax", "predictor"] })).rejects.toThrow(
      /aop_agents_check/,
    );
    await expect(insert({ agents: ["executor"] })).rejects.toThrow(/aop_agents_check/);
    await expect(insert({ clientIds: [] })).rejects.toThrow(/aop_client_ids_check/);
    await expect(
      insert({ clientIds: Array.from({ length: 21 }, (_, i) => `c${String(i)}`) }),
    ).rejects.toThrow(/aop_client_ids_check/);
    await expect(insert({ frequency: "hourly" })).rejects.toThrow(/aop_frequency_check/);
    await expect(insert({ weekday: 7 })).rejects.toThrow(/aop_weekday_check/);
    await expect(insert({ weekday: -1 })).rejects.toThrow(/aop_weekday_check/);
    await expect(insert({ day: 0 })).rejects.toThrow(/aop_day_check/);
    await expect(insert({ day: 29 })).rejects.toThrow(/aop_day_check/);
    await expect(insert({ hour: 24 })).rejects.toThrow(/aop_hour_check/);
    await expect(insert({ hour: -1 })).rejects.toThrow(/aop_hour_check/);

    // Controle: extremos válidos passam.
    await expect(
      insert({
        name: "x".repeat(120),
        description: "x".repeat(2000),
        agents: ["researcher", "assessor_liaison", "strategist"],
        clientIds: Array.from({ length: 20 }, (_, i) => `c${String(i)}`),
        frequency: "monthly",
        weekday: 6,
        day: 28,
        hour: 23,
      }),
    ).resolves.toBeDefined();
    await expect(
      insert({ frequency: "daily", weekday: 0, day: 1, hour: 0 }),
    ).resolves.toBeDefined();
  });

  it("CHECKs de aop_run recusam status, gatilho, falha e cobrança incoerentes", async () => {
    const aop = await create(tenantA);
    let n = 0;
    const insert = (over: {
      trigger?: string;
      status?: string;
      failureCode?: string | null;
      results?: string;
      workType?: string | null;
      priceBrl?: string | null;
    }) => {
      n += 1;
      const v = {
        trigger: "schedule",
        status: "ok",
        failureCode: null,
        results: "{}",
        workType: "analysis",
        priceBrl: "1.00",
        ...over,
      };
      return asApp(
        tenantA,
        `INSERT INTO aop_run (tenant_id, aop_id, client_id, fire_at, trigger, status,
                              failure_code, results, work_type, price_brl)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::numeric)`,
        [
          tenantA,
          aop.id,
          clientA1,
          new Date(Date.UTC(2025, 0, 1, 0, n)).toISOString(),
          v.trigger,
          v.status,
          v.failureCode,
          v.results,
          v.workType,
          v.priceBrl,
        ],
      );
    };
    const skipped = { status: "skipped", workType: null, priceBrl: null };

    // Cada caso viola só o CHECK esperado (o Postgres avalia os CHECKs em ordem de nome).
    await expect(
      insert({ ...skipped, status: "running", failureCode: "agents_failed" }),
    ).rejects.toThrow(/aop_run_status_check/);
    await expect(insert({ trigger: "webhook" })).rejects.toThrow(/aop_run_trigger_check/);
    await expect(insert({ ...skipped, failureCode: "timeout" })).rejects.toThrow(
      /aop_run_failure_code_check/,
    );
    await expect(insert({ results: "[]" })).rejects.toThrow(/aop_run_results_check/);
    await expect(insert({ priceBrl: "-1.00" })).rejects.toThrow(/aop_run_price_brl_check/);
    // work_type só dos valores do WorkTypeSchema.
    await expect(insert({ workType: "almoco" })).rejects.toThrow(/aop_run_work_type_check/);
    // ok ⇔ sem failure_code.
    await expect(insert({ failureCode: "agents_failed" })).rejects.toThrow(/aop_run_outcome_check/);
    await expect(insert({ ...skipped, failureCode: null })).rejects.toThrow(
      /aop_run_outcome_check/,
    );
    // Cobrança só quando executou: ok com tipo e preço; pulado/falho sem nenhum dos dois.
    await expect(insert({ workType: null })).rejects.toThrow(/aop_run_charge_check/);
    await expect(insert({ priceBrl: null })).rejects.toThrow(/aop_run_charge_check/);
    await expect(
      insert({ status: "failed", failureCode: "agents_failed", workType: "analysis" }),
    ).rejects.toThrow(/aop_run_charge_check/);
    await expect(
      insert({ ...skipped, failureCode: "client_not_found", priceBrl: "1.00" }),
    ).rejects.toThrow(/aop_run_charge_check/);

    // Controle.
    await expect(insert({})).resolves.toBeDefined();
    for (const workType of WorkTypeSchema.options) {
      await expect(insert({ workType })).resolves.toBeDefined();
    }
    await expect(
      insert({ status: "failed", failureCode: "agents_failed", workType: null, priceBrl: null }),
    ).resolves.toBeDefined();
    await expect(insert({ ...skipped, failureCode: "client_not_found" })).resolves.toBeDefined();
  });
});
