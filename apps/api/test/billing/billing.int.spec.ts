import { randomUUID } from "node:crypto";
import { MoneySchema, UsageSummarySchema } from "@carina/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { PrismaService } from "../../src/core/database/prisma.service.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { ValidationError } from "../../src/core/errors/domain-errors.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { BillingService } from "../../src/modules/billing/billing.service.js";
import { MAX_MONEY_BRL } from "../../src/modules/billing/pricing.js";
import { monthKey } from "../../src/modules/limits/month.js";
import { appUrl, migratorSql } from "../setup/db.js";

const Decimal = Prisma.Decimal;

describe("BillingService (carina_app, sob RLS)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantC = randomUUID();
  // Os registros levam created_at = now() do banco: o relógio injetado e o mês esperado são o atual.
  const NOW = Date.now();
  const MONTH = monthKey(NOW);
  let prisma: PrismaService;
  let db: TenantPrismaService;
  let billing: BillingService;

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    TenantContext.run({ tenantId }, fn);
  const inA = <T>(fn: () => Promise<T>) => inTenant(tenantA, fn);

  const countRecords = async (tenantId: string) =>
    Number(
      (
        await migratorSql<{ n: string }>(`SELECT count(*) AS n FROM usage_record`, [], {
          tenantId,
        })
      )[0]?.n,
    );

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan) VALUES ($1, 'A', 'pro'), ($2, 'B', 'pro'), ($3, 'C', 'pro')`,
      [tenantA, tenantB, tenantC],
    );
    prisma = new PrismaService({ DATABASE_URL: appUrl() });
    db = new TenantPrismaService(prisma);
    billing = new BillingService(db, { EXECUTION_FEE_PCT: 0.5 }, () => NOW);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("summary do tenant A ignora os registros de B e soma 3 registros (query, analysis, execution com fee)", async () => {
    await inA(async () => {
      await billing.record({ workType: "query", agents: [], durationMs: 10 });
      await billing.record({ workType: "analysis", agents: ["insight"], durationMs: 20 });
      const exec = await billing.record({
        workType: "execution",
        agents: ["executor"],
        valueBrl: new Decimal("100000"),
        durationMs: 30,
      });
      expect(exec.feeBrl.toFixed(2)).toBe("500.00");
      expect(exec.priceBrl.toFixed(2)).toBe("575.00");
      expect(exec.valueBrl.toFixed(2)).toBe("100000.00");
    });
    await inTenant(tenantB, async () => {
      await billing.record({ workType: "multi_agent_analysis", agents: ["a", "b"], durationMs: 1 });
      await billing.record({ workType: "query", agents: [], durationMs: 1 });
    });

    const summaryA = await inA(() => billing.summary());
    expect(summaryA).toEqual({
      month: MONTH,
      resolutions: 3,
      totalBrl: "584.00",
      byWorkType: {
        query: { count: 1, totalBrl: "1.50" },
        analysis: { count: 1, totalBrl: "7.50" },
        execution: { count: 1, totalBrl: "575.00" },
      },
    });
    expect(UsageSummarySchema.safeParse(summaryA).success).toBe(true);

    const summaryB = await inTenant(tenantB, () => billing.summary());
    expect(summaryB).toEqual({
      month: MONTH,
      resolutions: 2,
      totalBrl: "16.50",
      byWorkType: {
        multi_agent_analysis: { count: 1, totalBrl: "15.00" },
        query: { count: 1, totalBrl: "1.50" },
      },
    });
  });

  it("agrega por tipo (2 queries) e guarda o clientId opcional", async () => {
    const clientId = randomUUID();
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, 'c1')`,
      [clientId, tenantC],
      { tenantId: tenantC },
    );
    await inTenant(tenantC, async () => {
      const r1 = await billing.record({ workType: "query", agents: [], durationMs: 5, clientId });
      const r2 = await billing.record({ workType: "query", agents: [], durationMs: 6 });
      expect(r1.clientId).toBe(clientId);
      expect(r2.clientId).toBeNull();
      expect(r1.tenantId).toBe(tenantC);
    });
    const summary = await inTenant(tenantC, () => billing.summary(MONTH));
    expect(summary.byWorkType).toEqual({ query: { count: 2, totalBrl: "3.00" } });
    expect(summary.totalBrl).toBe("3.00");
  });

  it("o fee só vale para execution; valor movimentado em outros tipos não cobra fee", async () => {
    await inA(async () => {
      const r = await billing.record({
        workType: "analysis",
        agents: ["insight"],
        valueBrl: new Decimal("100000"),
        durationMs: 1,
      });
      expect(r.feeBrl.toFixed(2)).toBe("0.00");
      expect(r.priceBrl.toFixed(2)).toBe("7.50");
    });
  });

  it("arredonda o fee meio para cima ao gravar (0,5% de 201,00 = 1,005 -> 1,01)", async () => {
    await inTenant(tenantB, async () => {
      const r = await billing.record({
        workType: "execution",
        agents: [],
        valueBrl: new Decimal("201"),
        durationMs: 1,
      });
      expect(r.feeBrl.toFixed(2)).toBe("1.01");
      expect(r.priceBrl.toFixed(2)).toBe("76.01");
    });
  });

  it("record com tx entra na transação: o rollback remove o registro", async () => {
    const before = await countRecords(tenantA);
    class Boom extends Error {}
    await expect(
      inA(() =>
        db.tx(async (tx) => {
          await billing.record({ tx, workType: "query", agents: [], durationMs: 1 });
          // Visível dentro da própria transação.
          expect(await tx.usageRecord.count()).toBe(before + 1);
          throw new Boom();
        }),
      ),
    ).rejects.toBeInstanceOf(Boom);
    expect(await countRecords(tenantA)).toBe(before);
  });

  it("record com tx confirma junto com a transação no commit", async () => {
    const before = await countRecords(tenantA);
    await inA(() =>
      db.tx(async (tx) => {
        await billing.record({ tx, workType: "query", agents: [], durationMs: 1 });
      }),
    );
    expect(await countRecords(tenantA)).toBe(before + 1);
  });

  describe("limite de numeric(18,2)", () => {
    const tenantD = randomUUID();
    const inD = <T>(fn: () => Promise<T>) => inTenant(tenantD, fn);

    beforeAll(async () => {
      await migratorSql(`INSERT INTO tenant (id, name, plan) VALUES ($1, 'D', 'pro')`, [tenantD]);
    });

    it("MAX_MONEY_BRL é o maior valor de numeric(18,2) e passa no MoneySchema", () => {
      expect(MAX_MONEY_BRL.toFixed(2)).toBe("9999999999999999.99");
      expect(MoneySchema.safeParse(MAX_MONEY_BRL.toFixed(2)).success).toBe(true);
    });

    it.each([
      ["1e16", new Decimal(1e16)],
      ["1e300", new Decimal(1e300)],
      ['"99999999999999999999"', new Decimal("99999999999999999999")],
      ["10000000000000000.00", new Decimal("10000000000000000.00")],
      ["9999999999999999.995 (arredonda para 1e16)", new Decimal("9999999999999999.995")],
      ["-1e16", new Decimal("-1e16")],
      ["NaN", new Decimal(Number.NaN)],
      ["Infinity", new Decimal(Number.POSITIVE_INFINITY)],
      ["-Infinity", new Decimal(Number.NEGATIVE_INFINITY)],
    ])("valueBrl %s rejeita com ValidationError e não grava", async (_label, valueBrl) => {
      for (const workType of ["query", "execution"] as const) {
        await expect(
          inD(() => billing.record({ workType, agents: [], valueBrl, durationMs: 1 })),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await countRecords(tenantD)).toBe(0);
    });

    it("com tx, o erro não envenena a transação do chamador: a gravação seguinte confirma", async () => {
      await inD(() =>
        db.tx(async (tx) => {
          await expect(
            billing.record({
              tx,
              workType: "execution",
              agents: [],
              valueBrl: new Decimal(1e300),
              durationMs: 1,
            }),
          ).rejects.toBeInstanceOf(ValidationError);
          await billing.record({ tx, workType: "query", agents: [], durationMs: 1 });
        }),
      );
      expect(await countRecords(tenantD)).toBe(1);
    });

    it("o valor máximo representável ainda grava (tipo sem fee)", async () => {
      const r = await inD(() =>
        billing.record({
          workType: "query",
          agents: [],
          valueBrl: new Decimal("9999999999999999.99"),
          durationMs: 1,
        }),
      );
      expect(r.valueBrl.toFixed(2)).toBe("9999999999999999.99");
      expect(r.priceBrl.toFixed(2)).toBe("1.50");
    });

    it("execution no valor máximo com o fee padrão (0,5%) cabe e grava", async () => {
      const r = await inD(() =>
        billing.record({
          workType: "execution",
          agents: [],
          valueBrl: new Decimal("9999999999999999.99"),
          durationMs: 1,
        }),
      );
      expect(r.feeBrl.toFixed(2)).toBe("50000000000000.00");
      expect(r.priceBrl.toFixed(2)).toBe("50000000000075.00");
    });

    it("fee ou preço total acima do limite rejeitam (só com pct alto: com 0,5% é impossível)", async () => {
      const before = await countRecords(tenantD);
      // pct 100: fee = valor (cabe), mas 75,00 + fee passa de 9999999999999999.99.
      const pct100 = new BillingService(db, { EXECUTION_FEE_PCT: 100 }, () => NOW);
      await expect(
        inD(() =>
          pct100.record({
            workType: "execution",
            agents: [],
            valueBrl: new Decimal("9999999999999999.99"),
            durationMs: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      // pct 200: o próprio fee estoura.
      const pct200 = new BillingService(db, { EXECUTION_FEE_PCT: 200 }, () => NOW);
      await expect(
        inD(() =>
          pct200.record({
            workType: "execution",
            agents: [],
            valueBrl: new Decimal("9999999999999999.99"),
            durationMs: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await countRecords(tenantD)).toBe(before);
    });
  });

  it("sem contexto de tenant não grava nem lê", async () => {
    await expect(billing.record({ workType: "query", agents: [], durationMs: 1 })).rejects.toThrow(
      /contexto de tenant/,
    );
    await expect(billing.summary()).rejects.toThrow(/contexto de tenant/);
  });

  it("summary separa os meses pelo fuso de São Paulo", async () => {
    const tenant = randomUUID();
    await migratorSql(`INSERT INTO tenant (id, name, plan) VALUES ($1, 'M', 'pro')`, [tenant]);
    // 2026-04-01T02:30Z = 31 de março 23:30 em SP; 2026-04-01T03:00Z = 1º de abril 00:00 em SP.
    for (const [at, price] of [
      ["2026-04-01T02:30:00Z", "1.50"],
      ["2026-04-01T03:00:00Z", "7.50"],
      ["2026-03-01T02:59:59Z", "30.00"],
    ] as const) {
      await migratorSql(
        `INSERT INTO usage_record (tenant_id, work_type, agents, price_brl, duration_ms, created_at)
         VALUES ($1, 'query', '{}', $2, 0, $3)`,
        [tenant, price, at],
        { tenantId: tenant },
      );
    }
    const march = await inTenant(tenant, () => billing.summary("2026-03"));
    expect(march.resolutions).toBe(1);
    expect(march.totalBrl).toBe("1.50");
    const april = await inTenant(tenant, () => billing.summary("2026-04"));
    expect(april.resolutions).toBe(1);
    expect(april.totalBrl).toBe("7.50");
    const feb = await inTenant(tenant, () => billing.summary("2026-02"));
    expect(feb.resolutions).toBe(1);
    expect(feb.totalBrl).toBe("30.00");
    const empty = await inTenant(tenant, () => billing.summary("2025-01"));
    expect(empty).toEqual({ month: "2025-01", resolutions: 0, totalBrl: "0.00", byWorkType: {} });
  });

  it("summary rejeita mês inválido", async () => {
    await expect(inA(() => billing.summary("2026-13"))).rejects.toBeInstanceOf(ValidationError);
    await expect(inA(() => billing.summary("março"))).rejects.toBeInstanceOf(ValidationError);
  });
});
