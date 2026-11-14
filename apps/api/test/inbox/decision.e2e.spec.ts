import { ApprovalViewSchema } from "@carina/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { approvalId } from "../../src/modules/inbox/approval-id.js";
import { InboxModule } from "../../src/modules/inbox/inbox.module.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql, must } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const hex = () => approvalId(crypto.randomUUID(), 1, "place_trade", { n: Math.random() });

describe("Inbox HTTP: listagem e decisão", () => {
  let t: TestApp;
  let A: SeededTenant;
  let B: SeededTenant;
  let clientA: string;
  let clientB: string;

  async function seedClient(tenantId: string): Promise<string> {
    const [c] = await migratorSql<{ id: string }>(
      `INSERT INTO client (tenant_id, external_id) VALUES ($1, 'cli-1') RETURNING id`,
      [tenantId],
      { tenantId },
    );
    return must(c).id;
  }

  async function seedApproval(
    tenantId: string,
    clientId: string,
    opts: { status?: string; expiresInMs?: number } = {},
  ): Promise<string> {
    const id = hex();
    await migratorSql(
      `INSERT INTO approval_request (id, tenant_id, client_id, thread_id, agent, action, risk, payload,
         value_brl, status, expires_at)
       VALUES ($1, $2, $3, $4, 'executor', 'place_trade', 'irreversible', '{"symbol":"PETR4"}'::jsonb,
         1234.50, $5, now() + ($6 || ' milliseconds')::interval)`,
      [
        id,
        tenantId,
        clientId,
        `${tenantId}:${clientId}:x`,
        opts.status ?? "pending",
        String(opts.expiresInMs ?? 3_600_000),
      ],
      { tenantId },
    );
    return id;
  }

  const status = async (tenantId: string, id: string) =>
    (
      await migratorSql<{ status: string; decided_by_key_id: string | null }>(
        `SELECT status, decided_by_key_id FROM approval_request WHERE id = $1`,
        [id],
        { tenantId },
      )
    )[0];

  const post = (key: string | undefined, id: string, body: unknown) => {
    const r = request(t.app.getHttpServer()).post(`/api/inbox/${id}/decision`);
    return (key ? r.set("Authorization", `Bearer ${key}`) : r).send(body as object);
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [InboxModule],
      redisDb: redisDbOf("inbox/decision.e2e.spec.ts"),
    });
    A = await t.seedTenant({ name: "A" });
    B = await t.seedTenant({ name: "B" });
    clientA = await seedClient(A.tenantId);
    clientB = await seedClient(B.tenantId);
  });

  afterAll(async () => {
    await t?.close();
  });

  describe("GET /api/clients/:clientId/inbox", () => {
    it("chat OU inbox:decide listam; data:write e sem chave não", async () => {
      const id = await seedApproval(A.tenantId, clientA);
      await seedApproval(B.tenantId, clientB); // outro tenant: nunca aparece
      const get = (key?: string) => {
        const r = request(t.app.getHttpServer()).get("/api/clients/cli-1/inbox");
        return key ? r.set("Authorization", `Bearer ${key}`) : r;
      };
      const chat = await get(A.keys.chat);
      expect(chat.status).toBe(200);
      const body = chat.body as unknown[];
      expect(body.map((v) => ApprovalViewSchema.parse(v).id)).toContain(id);
      expect(body).toHaveLength(1);
      expect((await get(A.keys.approver)).status).toBe(200);
      const onlyDecide = await t.createKey(A.tenantId, { scopes: ["inbox:decide"] });
      expect((await get(onlyDecide)).status).toBe(200);
      expect((await get(A.keys.ingest)).status).toBe(403);
      expect((await get()).status).toBe(401);
    });

    it("cliente inexistente: 404", async () => {
      const res = await request(t.app.getHttpServer())
        .get("/api/clients/nao-existe/inbox")
        .set("Authorization", `Bearer ${A.keys.chat}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/inbox/:id/decision", () => {
    it("chave sem inbox:decide: 403 e a solicitação segue pendente", async () => {
      const id = await seedApproval(A.tenantId, clientA);
      const res = await post(A.keys.chat, id, { approved: true });
      expect(res.status).toBe(403);
      expect(await status(A.tenantId, id)).toMatchObject({ status: "pending" });
      expect((await post(undefined, id, { approved: true })).status).toBe(401);
    });

    it("aprova: 200 com ApprovalView e grava a chave decisora; a segunda decisão dá 409", async () => {
      const id = await seedApproval(A.tenantId, clientA);
      const res = await post(A.keys.approver, id, { approved: true, reason: "ok" });
      expect(res.status).toBe(200);
      expect(ApprovalViewSchema.parse(res.body)).toMatchObject({
        id,
        status: "approved",
        clientId: "cli-1",
      });
      const s = await status(A.tenantId, id);
      expect(s?.status).toBe("approved");
      expect(s?.decided_by_key_id).not.toBeNull();

      const again = await post(A.keys.approver, id, { approved: false });
      expect(again.status).toBe(409);
      expect(await status(A.tenantId, id)).toMatchObject({ status: "approved" });
      expect((await post(A.keys.approver, id, { approved: true })).status).toBe(409);
    });

    it("rejeita: 200 com status rejected", async () => {
      const id = await seedApproval(A.tenantId, clientA);
      const res = await post(A.keys.approver, id, { approved: false });
      expect(res.status).toBe(200);
      expect((res.body as { status: string }).status).toBe("rejected");
    });

    it("solicitação de outro tenant: 404 com o mesmo corpo de uma inexistente, e nada muda", async () => {
      const idB = await seedApproval(B.tenantId, clientB);
      const cross = await post(A.keys.approver, idB, { approved: true });
      const missing = await post(A.keys.approver, hex(), { approved: true });
      expect(cross.status).toBe(404);
      expect(missing.status).toBe(404);
      const strip = (b: Record<string, unknown>) => ({ ...b, traceId: undefined });
      expect(strip(cross.body as Record<string, unknown>)).toEqual(
        strip(missing.body as Record<string, unknown>),
      );
      expect(JSON.stringify(cross.body)).not.toContain(idB);
      expect(await status(B.tenantId, idB)).toMatchObject({
        status: "pending",
        decided_by_key_id: null,
      });
      // id que nem tem o formato de hash: também 404
      expect((await post(A.keys.approver, "lixo", { approved: true })).status).toBe(404);
    });

    it("solicitação vencida: 409 e a linha passa a expired", async () => {
      const id = await seedApproval(A.tenantId, clientA, { expiresInMs: -60_000 });
      const res = await post(A.keys.approver, id, { approved: true });
      expect(res.status).toBe(409);
      expect(await status(A.tenantId, id)).toMatchObject({ status: "expired" });
    });

    it.each([
      ["sem corpo", undefined],
      ["approved ausente", {}],
      ["approved não booleano", { approved: "sim" }],
      ["reason longo demais", { approved: true, reason: "x".repeat(501) }],
      ["reason não texto", { approved: true, reason: 1 }],
    ])("corpo inválido (%s): 422 e nada muda", async (_n, body) => {
      const id = await seedApproval(A.tenantId, clientA);
      const res = await post(A.keys.approver, id, body ?? {});
      expect(res.status).toBe(422);
      expect(await status(A.tenantId, id)).toMatchObject({ status: "pending" });
    });
  });
});
