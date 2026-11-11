-- 0002_rls — papéis, grants, Row-Level Security e autenticação por chave (SQL escrito à mão).
--
-- Roda como carina_migrator (dono das tabelas). Modelo de segurança:
--   * carina_app (API e workers) é NOSUPERUSER NOBYPASSRLS e só recebe os grants abaixo;
--   * toda tabela de dados tem ENABLE + FORCE ROW LEVEL SECURITY (o dono também passa pelas
--     políticas); sem app.tenant_id fixado, nenhuma linha volta (falha fechada);
--   * tenant: ENABLE sem FORCE, só leitura do próprio tenant; o dono continua lendo, o que
--     resolve_api_key (SECURITY DEFINER) precisa;
--   * api_key: sem nenhum grant para carina_app; só resolve_api_key a lê.
-- Tabelas novas em migrações futuras NÃO herdam grants (sem ALTER DEFAULT PRIVILEGES de
-- propósito): cada uma precisa dos seus GRANT, ENABLE/FORCE RLS e política explícitos.

-- ─── Checkpoints do LangGraph (tabelas da biblioteca, sem RLS) ───────────────
CREATE SCHEMA langgraph;
GRANT USAGE, CREATE ON SCHEMA langgraph TO carina_app;

-- ─── Grants ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant, client, approval_request, executed_action, position, transaction, import_job,
  kg_document, kg_chunk, kg_entity, kg_relation, kg_mention
TO carina_app;

-- Append-only: sem UPDATE/DELETE.
GRANT SELECT, INSERT ON usage_record, audit_event TO carina_app;
REVOKE UPDATE, DELETE, TRUNCATE ON usage_record, audit_event FROM carina_app;

-- Chaves: só via resolve_api_key.
REVOKE ALL ON api_key FROM carina_app;

-- ─── Contexto da requisição ─────────────────────────────────────────────────
-- tenant atual (NULL quando não fixado → nenhuma linha)
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_client() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.client_id', true), '')::uuid $$;

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE client ENABLE ROW LEVEL SECURITY;
ALTER TABLE client FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_request FORCE ROW LEVEL SECURITY;
ALTER TABLE executed_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE executed_action FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_record FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
ALTER TABLE position ENABLE ROW LEVEL SECURITY;
ALTER TABLE position FORCE ROW LEVEL SECURITY;
ALTER TABLE transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction FORCE ROW LEVEL SECURITY;
ALTER TABLE import_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job FORCE ROW LEVEL SECURITY;
ALTER TABLE kg_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_document FORCE ROW LEVEL SECURITY;
ALTER TABLE kg_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_chunk FORCE ROW LEVEL SECURITY;
ALTER TABLE kg_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_entity FORCE ROW LEVEL SECURITY;
ALTER TABLE kg_relation ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_relation FORCE ROW LEVEL SECURITY;
ALTER TABLE kg_mention ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_mention FORCE ROW LEVEL SECURITY;

-- tenant: só o próprio tenant, só leitura (sem política de escrita → INSERT/UPDATE/DELETE negados).
-- Sem FORCE: o dono (e resolve_api_key, SECURITY DEFINER) lê sem contexto.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON tenant FOR SELECT USING (id = app_tenant());

-- por tenant: usage_record, audit_event
CREATE POLICY tenant_only ON usage_record USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY tenant_only ON audit_event USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- por cliente (client_id opcional): approval_request, executed_action, position, transaction, import_job
CREATE POLICY tenant_client ON approval_request
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));
CREATE POLICY tenant_client ON executed_action
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));
CREATE POLICY tenant_client ON position
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));
CREATE POLICY tenant_client ON transaction
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));
CREATE POLICY tenant_client ON import_job
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));

-- tabela client: mesma regra usando a coluna id no lugar de client_id
CREATE POLICY tenant_client ON client
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR id = app_client()));

-- conhecimento (cliente obrigatório): kg_document, kg_chunk, kg_entity, kg_relation, kg_mention
CREATE POLICY tenant_client_strict ON kg_document
  USING (tenant_id = app_tenant() AND client_id = app_client())
  WITH CHECK (tenant_id = app_tenant() AND client_id = app_client());
CREATE POLICY tenant_client_strict ON kg_chunk
  USING (tenant_id = app_tenant() AND client_id = app_client())
  WITH CHECK (tenant_id = app_tenant() AND client_id = app_client());
CREATE POLICY tenant_client_strict ON kg_entity
  USING (tenant_id = app_tenant() AND client_id = app_client())
  WITH CHECK (tenant_id = app_tenant() AND client_id = app_client());
CREATE POLICY tenant_client_strict ON kg_relation
  USING (tenant_id = app_tenant() AND client_id = app_client())
  WITH CHECK (tenant_id = app_tenant() AND client_id = app_client());
CREATE POLICY tenant_client_strict ON kg_mention
  USING (tenant_id = app_tenant() AND client_id = app_client())
  WITH CHECK (tenant_id = app_tenant() AND client_id = app_client());

-- ─── Autenticação por chave de API ──────────────────────────────────────────
-- Roda com os privilégios do dono: lê api_key (sem grant para carina_app) e tenant (sem FORCE).
-- Isolamento do SECURITY DEFINER: pg_temp vai por último no search_path (sem ele, o schema
-- temporário é consultado PRIMEIRO, e carina_app, que tem TEMPORARY, poderia sombrear api_key e
-- tenant com tabelas temporárias e forjar o tenant), e as tabelas são qualificadas com public.
CREATE FUNCTION resolve_api_key(p_hash text)
  RETURNS TABLE(key_id uuid, tenant_id uuid, tenant_name text, scopes text[], rpm int, monthly_quota int)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT k.id, t.id, t.name, k.scopes, t.rpm, t.monthly_quota
  FROM public.api_key k
  JOIN public.tenant t ON t.id = k.tenant_id
  WHERE k.hash = p_hash AND k.revoked_at IS NULL
$$;
ALTER FUNCTION resolve_api_key(text) OWNER TO carina_migrator;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO carina_app;
