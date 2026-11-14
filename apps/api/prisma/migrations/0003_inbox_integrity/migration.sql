-- 0003_inbox_integrity — FKs compostas da inbox (SQL escrito à mão; ver o cabeçalho do schema.prisma).
--
-- Antes, executed_action.approval_request_id tinha FK de coluna única: tenant/cliente da linha
-- podiam divergir dos da aprovação; e approval_request.decided_by_key_id podia apontar para a
-- chave de OUTRO tenant. Agora o banco recusa as duas (SQLSTATE 23503).

-- Alvos das FKs compostas.
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_tenant_id_id_key" UNIQUE ("tenant_id", "id");
ALTER TABLE "approval_request"
  ADD CONSTRAINT "approval_request_tenant_id_client_id_id_key" UNIQUE ("tenant_id", "client_id", "id");

-- decided_by_key_id é anulável: MATCH SIMPLE (padrão) não confere a FK quando alguma coluna é NULL,
-- então um decisor NULL continua permitido. ON DELETE SET NULL só na coluna opcional (PostgreSQL 15+),
-- para não anular tenant_id (NOT NULL).
ALTER TABLE "approval_request" DROP CONSTRAINT "approval_request_decided_by_key_id_fkey";
ALTER TABLE "approval_request"
  ADD CONSTRAINT "approval_request_tenant_id_decided_by_key_id_fkey"
  FOREIGN KEY ("tenant_id", "decided_by_key_id") REFERENCES "api_key"("tenant_id", "id")
  ON DELETE SET NULL ("decided_by_key_id") ON UPDATE CASCADE;

-- Redundante com a PK; o Prisma exige uma chave única nos campos da FK composta (relação 1:1).
ALTER TABLE "executed_action"
  ADD CONSTRAINT "executed_action_tenant_id_client_id_approval_request_id_key"
  UNIQUE ("tenant_id", "client_id", "approval_request_id");

-- executed_action acompanha o tenant/cliente da aprovação.
ALTER TABLE "executed_action" DROP CONSTRAINT "executed_action_approval_request_id_fkey";
ALTER TABLE "executed_action"
  ADD CONSTRAINT "executed_action_tenant_id_client_id_approval_request_id_fkey"
  FOREIGN KEY ("tenant_id", "client_id", "approval_request_id")
  REFERENCES "approval_request"("tenant_id", "client_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
