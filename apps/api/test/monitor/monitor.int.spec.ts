/**
 * Monitor de carteira (spec §4.1–4.3): tabela portfolio_alert sob RLS, função
 * `monitor_tenant_ids()` (SECURITY DEFINER) e o MonitorRepository, conectado como carina_app
 * (NOBYPASSRLS). Os dados são preparados como carina_migrator com o contexto de RLS fixado.
 * O banco é compartilhado com os outros arquivos int: as asserções sobre `tenantIds` olham só os
 * tenants deste arquivo.
 *
 * O MonitorJob roda de verdade (MonitorCoreModule + MarketService + Redis), com o provedor de
 * cotações trocado por um falso (variações forjadas) e o CLOCK fixado no pregão. Redis: o DB é
 * DIVIDIDO com app/app-graph.int.spec.ts (test/setup/redis-dbs.ts, SHARED_REDIS_DBS), que não lê
 * nem esvazia nada: aqui também nada é esvaziado, só as chaves do monitor e do mercado são apagadas,
 * e os eventos de `inbox.events` são filtrados pelos tenants deste arquivo.
 */
import { randomUUID } from "node:crypto";
import {
  PortfolioAlertSchema,
  type PortfolioAlert,
  type StreamEvent,
  StreamEventSchema,
} from "@carina/shared";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { REDIS } from "../../src/core/redis/redis.tokens.js";
import { CLOCK } from "../../src/modules/limits/clock.js";
import { MARKET_DATA_PROVIDER } from "../../src/modules/market/market.service.js";
import type { MarketDataProvider, RawQuote } from "../../src/modules/market/providers/types.js";
import { MonitorCoreModule } from "../../src/modules/monitor/monitor-core.module.js";
import {
  MONITOR_CURSOR_KEY,
  MONITOR_LOCK_KEY,
  MONITOR_LOGGER,
  MonitorJob,
} from "../../src/modules/monitor/monitor.job.js";
import { PrismaService } from "../../src/core/database/prisma.service.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { ValidationError } from "../../src/core/errors/domain-errors.js";
import { MonitorRepository, type NewAlert } from "../../src/modules/monitor/monitor.repository.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { appUrl, inRlsTransaction, migratorSql, must, withPgClient } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("monitor/monitor.int.spec.ts");

describe("Monitor de carteira: portfolio_alert e MonitorRepository (carina_app, sob RLS)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantSuspenso = randomUUID();
  const tenantSoCaixa = randomUUID();
  const clientA1 = randomUUID();
  const clientA2 = randomUUID();
  const clientB1 = randomUUID();
  const clientS1 = randomUUID();
  const clientC1 = randomUUID();

  let prisma: PrismaService;
  let db: TenantPrismaService;
  let repo: MonitorRepository;

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>, clientId?: string) =>
    TenantContext.run({ tenantId, ...(clientId !== undefined ? { clientId } : {}) }, fn);

  const insert = (tenantId: string, row: NewAlert) =>
    inTenant(tenantId, () => db.tx((tx) => repo.insertIfNew(tx, row)));

  const list = (tenantId: string, clientId: string, cursor: string | null, limit: number) =>
    inTenant(tenantId, () => db.tx((tx) => repo.list(tx, clientId, cursor, limit)));

  const alertRow = (over: Partial<NewAlert> = {}): NewAlert => ({
    clientId: clientA1,
    assetCode: "PETR4",
    direction: "down",
    changePct: "-6.2",
    price: "31.4",
    tradingDay: "2026-11-21",
    ...over,
  });

  const position = (
    tenantId: string,
    clientId: string,
    externalId: string,
    kind: string,
    assetCode: string | null,
    source = "synthetic",
  ) =>
    migratorSql(
      `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
                             asset_class, asset_code, name, quantity, value_brl, as_of)
       VALUES ($1, $2, $3, $4, 'XP', $5, 'stock', $6, 'Ativo', 10, 1000, current_date)`,
      [tenantId, clientId, source, externalId, kind, assetCode],
      { tenantId },
    );

  const countAlerts = async (tenantId: string, clientId: string) =>
    Number(
      must(
        (
          await migratorSql<{ n: string }>(
            "SELECT count(*)::text AS n FROM portfolio_alert WHERE client_id = $1",
            [clientId],
            { tenantId },
          )
        )[0],
      ).n,
    );

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan, suspended_at) VALUES
         ($1, 'Monitor A', 'pro', NULL), ($2, 'Monitor B', 'pro', NULL),
         ($3, 'Monitor suspenso', 'pro', now()), ($4, 'Monitor só caixa', 'pro', NULL)`,
      [tenantA, tenantB, tenantSuspenso, tenantSoCaixa],
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
    await client(tenantSuspenso, clientS1, "s1");
    await client(tenantSoCaixa, clientC1, "c1");

    // A: a1 com PETR4 em duas fontes (uma em minúsculas), " vale 3" com espaços, investimento sem
    // código e caixa com código; a2 com PETR4.
    await position(tenantA, clientA1, "p1", "investment", "PETR4");
    await position(tenantA, clientA1, "p2", "investment", "petr4", "import");
    await position(tenantA, clientA1, "p3", "investment", " vale 3");
    await position(tenantA, clientA1, "p4", "investment", null);
    await position(tenantA, clientA1, "p5", "cash", "CDB1");
    await position(tenantA, clientA1, "p6", "investment", "   ");
    await position(tenantA, clientA2, "p1", "investment", "PETR4");
    await position(tenantB, clientB1, "p1", "investment", "ITUB4");
    await position(tenantSuspenso, clientS1, "p1", "investment", "BBAS3");
    await position(tenantSoCaixa, clientC1, "p1", "cash", "CDB1");
    await position(tenantSoCaixa, clientC1, "p2", "investment", null);

    prisma = new PrismaService({ DATABASE_URL: appUrl() });
    db = new TenantPrismaService(prisma);
    repo = new MonitorRepository(db);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("insertIfNew grava uma vez por dia e sentido; segundo insert devolve null", async () => {
    const first = must(await insert(tenantA, alertRow()), "alerta inserido");
    expect(PortfolioAlertSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      assetCode: "PETR4",
      direction: "down",
      changePct: "-6.2",
      price: "31.4",
      tradingDay: "2026-11-21",
    });

    // mesma chave, outra variação: nada muda
    expect(await insert(tenantA, alertRow({ changePct: "-8", price: "30" }))).toBeNull();
    // outro dia grava de novo
    expect(await insert(tenantA, alertRow({ tradingDay: "2026-11-22" }))).not.toBeNull();

    const rows = await migratorSql<{ change_pct: string; trading_day: string }>(
      `SELECT change_pct::text, to_char(trading_day, 'YYYY-MM-DD') AS trading_day
         FROM portfolio_alert WHERE client_id = $1 AND asset_code = 'PETR4' AND direction = 'down'
        ORDER BY trading_day`,
      [clientA1],
      { tenantId: tenantA },
    );
    expect(rows).toEqual([
      { change_pct: "-6.2000", trading_day: "2026-11-21" },
      { change_pct: "-6.2000", trading_day: "2026-11-22" },
    ]);
  });

  it("mesmo ativo, sentido oposto no mesmo dia grava", async () => {
    const day = "2026-10-01";
    expect(await insert(tenantA, alertRow({ tradingDay: day, assetCode: "VALE3" }))).not.toBeNull();
    const up = must(
      await insert(
        tenantA,
        alertRow({ tradingDay: day, assetCode: "VALE3", direction: "up", changePct: "5" }),
      ),
    );
    expect(up).toMatchObject({ direction: "up", changePct: "5", assetCode: "VALE3" });
    // e o mesmo sentido outra vez não grava
    expect(
      await insert(tenantA, alertRow({ tradingDay: day, assetCode: "VALE3", direction: "up" })),
    ).toBeNull();
  });

  it("direction fora de up/down é recusada pelo banco (CHECK)", async () => {
    await expect(
      insert(tenantA, alertRow({ direction: "sideways" as "up", tradingDay: "2026-09-01" })),
    ).rejects.toThrow(/portfolio_alert_direction_check/);
  });

  it("RLS: tenant B não lê nem insere alerta de cliente de A", async () => {
    await insert(tenantA, alertRow({ tradingDay: "2026-09-02" }));
    expect(await countAlerts(tenantA, clientA1)).toBeGreaterThan(0);

    // B não lê
    expect(await list(tenantB, clientA1, null, 50)).toEqual({ items: [], nextCursor: null });
    const seen = await withPgClient(appUrl(), (c) =>
      inRlsTransaction(c, { tenantId: tenantB }, () =>
        c.query<{ n: string }>("SELECT count(*)::text AS n FROM portfolio_alert"),
      ),
    );
    expect(seen.rows[0]?.n).toBe("0");

    // sem tenant fixado, nada (falha fechada)
    const none = await withPgClient(appUrl(), (c) =>
      c.query<{ n: string }>("SELECT count(*)::text AS n FROM portfolio_alert"),
    );
    expect(none.rows[0]?.n).toBe("0");

    // B não insere para o cliente de A: pelo repositório (tenant B + cliente de A → FK composta)
    await expect(insert(tenantB, alertRow({ tradingDay: "2026-09-03" }))).rejects.toThrow();
    // nem forjando tenant_id = A (WITH CHECK da política)
    const forged = withPgClient(appUrl(), (c) =>
      inRlsTransaction(c, { tenantId: tenantB }, () =>
        c.query(
          `INSERT INTO portfolio_alert (tenant_id, client_id, asset_code, direction, change_pct,
                                        price, trading_day)
           VALUES ($1, $2, 'PETR4', 'down', -6, 31, '2026-09-03')`,
          [tenantA, clientA1],
        ),
      ),
    );
    await expect(forged).rejects.toMatchObject({ code: "42501" });
  });

  it("apagar o cliente apaga os alertas (cascade)", async () => {
    const clientA3 = randomUUID();
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, 'a3')`,
      [clientA3, tenantA],
      { tenantId: tenantA },
    );
    await insert(tenantA, alertRow({ clientId: clientA3 }));
    await insert(tenantA, alertRow({ clientId: clientA3, direction: "up", changePct: "6" }));
    expect(await countAlerts(tenantA, clientA3)).toBe(2);

    // como carina_app, sob o tenant
    await withPgClient(appUrl(), (c) =>
      inRlsTransaction(c, { tenantId: tenantA }, () =>
        c.query("DELETE FROM client WHERE id = $1", [clientA3]),
      ),
    );
    expect(await countAlerts(tenantA, clientA3)).toBe(0);
  });

  it("tenantIds ignora tenant suspenso e tenant sem posição de investimento", async () => {
    const ids = await repo.tenantIds();
    expect(ids).toContain(tenantA);
    expect(ids).toContain(tenantB);
    expect(ids).not.toContain(tenantSuspenso);
    expect(ids).not.toContain(tenantSoCaixa);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("monitor_tenant_ids: SECURITY DEFINER do carina_migrator, EXECUTE só para carina_app", async () => {
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
         FROM pg_proc p WHERE p.proname = 'monitor_tenant_ids'`,
    );
    expect(fn).toEqual({
      secdef: true,
      owner: "carina_migrator",
      public_exec: false,
      app_exec: true,
      config: ["search_path=public, pg_temp"],
    });
  });

  it("watchList só traz investment com asset_code", async () => {
    const got = await inTenant(tenantA, () => db.tx((tx) => repo.watchList(tx)));
    const expected = [
      { clientId: clientA1, assetCode: "PETR4" },
      { clientId: clientA1, assetCode: "VALE3" },
      { clientId: clientA2, assetCode: "PETR4" },
    ].sort((a, b) =>
      a.clientId === b.clientId
        ? a.assetCode.localeCompare(b.assetCode)
        : a.clientId < b.clientId
          ? -1
          : 1,
    );
    expect(got).toEqual(expected);

    // sob RLS: B só vê os seus
    expect(await inTenant(tenantB, () => db.tx((tx) => repo.watchList(tx)))).toEqual([
      { clientId: clientB1, assetCode: "ITUB4" },
    ]);
  });

  it("list pagina do mais novo para o mais antigo com cursor", async () => {
    const inserted: PortfolioAlert[] = [];
    for (let i = 0; i < 5; i++) {
      inserted.push(
        must(
          await insert(
            tenantA,
            alertRow({
              clientId: clientA2,
              assetCode: `ATV${i.toString()}`,
              tradingDay: "2026-08-03",
            }),
          ),
        ),
      );
    }
    // alerta de outro cliente do mesmo tenant não entra
    await insert(tenantA, alertRow({ clientId: clientA1, tradingDay: "2026-08-03" }));

    const newestFirst = [...inserted].reverse();
    const p1 = await list(tenantA, clientA2, null, 2);
    expect(p1.items).toEqual(newestFirst.slice(0, 2));
    const c1 = must(p1.nextCursor, "cursor da página 1");
    const p2 = await list(tenantA, clientA2, c1, 2);
    expect(p2.items).toEqual(newestFirst.slice(2, 4));
    const c2 = must(p2.nextCursor, "cursor da página 2");
    const p3 = await list(tenantA, clientA2, c2, 2);
    expect(p3).toEqual({ items: newestFirst.slice(4), nextCursor: null });

    // página exata: sem próxima
    expect((await list(tenantA, clientA2, null, 5)).nextCursor).toBeNull();
    // com o cliente fixado no contexto também funciona
    const pinned = await inTenant(
      tenantA,
      () => db.tx((tx) => repo.list(tx, clientA2, null, 50)),
      clientA2,
    );
    expect(pinned.items).toEqual(newestFirst);
  });

  it("list com cursor inválido lança ValidationError", async () => {
    for (const bad of ["xyz", "", Buffer.from("nada|aqui").toString("base64url")]) {
      await expect(list(tenantA, clientA1, bad, 10)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe("MonitorJob: ciclo completo (Postgres + Redis, provedor forjado)", () => {
  const tenantM1: string = randomUUID();
  const tenantM2: string = randomUUID();
  const clientM1 = randomUUID();
  const clientM2 = randomUUID();
  // segunda-feira 2026-11-16, 15:00 em São Paulo (pregão aberto)
  const MONDAY = Date.parse("2026-11-16T18:00:00.000Z");
  // terça-feira 2026-11-17, 11:00 em São Paulo
  const TUESDAY = Date.parse("2026-11-17T14:00:00.000Z");

  let now = MONDAY;
  /** Variação forjada por símbolo; o que não está aqui vem com 0%. */
  const forged: Record<string, string> = {};
  const fetched: string[][] = [];
  const logged: unknown[] = [];
  const provider: MarketDataProvider = {
    fetchQuotes: (symbols) => {
      fetched.push(symbols);
      return Promise.resolve(
        symbols.map((symbol): RawQuote => ({
          symbol,
          name: symbol,
          assetClass: "stock",
          price: "31.4",
          changePct: forged[symbol] ?? "0",
          previousClose: "33.4",
          volume: "1000",
          currency: "BRL",
          updatedAt: new Date(now).toISOString(),
          source: "mock",
        })),
      );
    },
    fetchHistory: () => Promise.resolve([]),
  };

  let t: TestApp;
  let redis: Redis;
  let job: MonitorJob;

  const run = () => job.runOnce({ onlyTenants: [tenantM1, tenantM2] });

  const alertEvents = async (): Promise<Extract<StreamEvent, { type: "monitor.alert" }>[]> =>
    (await redis.xrange("inbox.events", "-", "+"))
      .map(([, f]) => StreamEventSchema.parse(JSON.parse(f[1] as string)))
      .flatMap((e) =>
        e.type === "monitor.alert" && [tenantM1, tenantM2].includes(e.tenantId) ? [e] : [],
      );

  const alertsOf = (tenantId: string) =>
    migratorSql<{
      id: string;
      tenant_id: string;
      client_id: string;
      asset_code: string;
      direction: string;
      change_pct: string;
      trading_day: string;
    }>(
      `SELECT id::text, tenant_id::text, client_id::text, asset_code, direction,
              change_pct::text, to_char(trading_day, 'YYYY-MM-DD') AS trading_day
         FROM portfolio_alert ORDER BY trading_day, asset_code`,
      [],
      { tenantId },
    );

  /** Só as chaves do monitor e do mercado: o DB é dividido (ver o topo do arquivo). */
  const clearKeys = async () => {
    const keys = [MONITOR_LOCK_KEY, MONITOR_CURSOR_KEY, ...(await redis.keys("market:*"))];
    await redis.del(...keys);
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [MonitorCoreModule],
      redisDb: REDIS_DB,
      env: { MARKET_MODE: "mock" },
      overrides: [
        { token: CLOCK, useValue: () => now },
        { token: MARKET_DATA_PROVIDER, useValue: provider },
        {
          token: MONITOR_LOGGER,
          useValue: {
            info: (f: unknown) => logged.push(f),
            warn: (f: unknown) => logged.push(f),
            error: (f: unknown) => logged.push(f),
          },
        },
      ],
    });
    redis = t.app.get<Redis>(REDIS);
    job = t.app.get(MonitorJob);

    await migratorSql(
      `INSERT INTO tenant (id, name, plan) VALUES ($1, 'Monitor job 1', 'pro'),
                                                 ($2, 'Monitor job 2', 'pro')`,
      [tenantM1, tenantM2],
    );
    const seed = async (tenantId: string, clientId: string, codes: string[]) => {
      await migratorSql(
        `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, 'm')`,
        [clientId, tenantId],
        { tenantId },
      );
      for (const [i, code] of codes.entries()) {
        await migratorSql(
          `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
                                 asset_class, asset_code, name, quantity, value_brl, as_of)
           VALUES ($1, $2, 'synthetic', $3, 'XP', 'investment', 'stock', $4, 'Ativo', 10,
                   987654.32, current_date)`,
          [tenantId, clientId, `p${i.toString()}`, code],
          { tenantId },
        );
      }
    };
    await seed(tenantM1, clientM1, ["PETR4", "VALE3"]);
    await seed(tenantM2, clientM2, ["petr4", "WEGE3"]);
  });

  afterAll(async () => {
    await clearKeys();
    await t.close();
  });

  beforeEach(async () => {
    await clearKeys();
  });

  it("ciclo com dois tenants e cotação forjada de −6% grava alertas sob o tenant certo e publica monitor.alert", async () => {
    now = MONDAY;
    forged["PETR4"] = "-6";
    forged["VALE3"] = "-1.5";
    forged["WEGE3"] = "4.99";
    const calls = fetched.length;

    const result = await run();
    expect(result).toEqual({
      skipped: false,
      closed: false,
      tenants: 2,
      symbols: 3,
      alerts: 2,
      exhausted: false,
    });
    // em lotes de MARKET_BRAPI_MAX_SYMBOLS_PER_CALL, na ordem do rodízio
    expect(fetched.slice(calls).flat()).toEqual(["PETR4", "VALE3", "WEGE3"]);

    const m1 = await alertsOf(tenantM1);
    const m2 = await alertsOf(tenantM2);
    expect(m1).toEqual([
      expect.objectContaining({
        tenant_id: tenantM1,
        client_id: clientM1,
        asset_code: "PETR4",
        direction: "down",
        change_pct: "-6.0000",
        trading_day: "2026-11-16",
      }),
    ]);
    expect(m2).toEqual([
      expect.objectContaining({ tenant_id: tenantM2, client_id: clientM2, asset_code: "PETR4" }),
    ]);

    const events = await alertEvents();
    expect(events).toHaveLength(2);
    const byTenant = new Map(events.map((e) => [e.tenantId, e]));
    expect(byTenant.get(tenantM1)).toMatchObject({
      clientId: clientM1,
      alert: { id: must(m1[0]).id, assetCode: "PETR4", direction: "down", changePct: "-6" },
    });
    expect(byTenant.get(tenantM2)).toMatchObject({
      clientId: clientM2,
      alert: { id: must(m2[0]).id, tradingDay: "2026-11-16" },
    });

    // lock liberado, cursor no último cotado, e nenhum valor de posição nos logs
    expect(await redis.get(MONITOR_LOCK_KEY)).toBeNull();
    expect(await redis.get(MONITOR_CURSOR_KEY)).toBe("WEGE3");
    expect(JSON.stringify(logged)).not.toContain("987654");
  });

  it("segundo ciclo no mesmo dia não duplica nem publica de novo", async () => {
    now = MONDAY + 15 * 60_000;
    forged["PETR4"] = "-7.25";
    const before = (await alertEvents()).length;

    expect(await run()).toMatchObject({ skipped: false, alerts: 0 });
    expect(await alertsOf(tenantM1)).toHaveLength(1);
    expect(await alertsOf(tenantM2)).toHaveLength(1);
    expect((await alertEvents()).length).toBe(before);
  });

  it("virada do dia em São Paulo alerta de novo", async () => {
    now = TUESDAY;
    forged["PETR4"] = "-6.5";
    const before = (await alertEvents()).length;

    expect(await run()).toMatchObject({ alerts: 2 });
    const m1 = await alertsOf(tenantM1);
    expect(m1.map((a) => a.trading_day)).toEqual(["2026-11-16", "2026-11-17"]);
    const fresh = (await alertEvents()).slice(before);
    expect(fresh.map((e) => e.alert.tradingDay)).toEqual(["2026-11-17", "2026-11-17"]);
  });

  it("fora do pregão o ciclo é vazio e outra réplica com o lock pula o ciclo", async () => {
    now = Date.parse("2026-11-17T22:00:00.000Z"); // terça 19:00 em São Paulo
    const calls = fetched.length;
    expect(await run()).toMatchObject({ closed: true, alerts: 0 });

    now = TUESDAY + 60 * 60_000;
    await redis.set(MONITOR_LOCK_KEY, "outra-replica", "PX", 60_000);
    expect(await run()).toMatchObject({ skipped: true, alerts: 0 });
    expect(fetched.length).toBe(calls);
  });
});
