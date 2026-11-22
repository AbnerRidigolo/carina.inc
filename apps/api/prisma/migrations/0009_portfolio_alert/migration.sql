-- 0009_portfolio_alert — monitor de carteira (spec §4.1–4.3): alertas de variação forte e
-- enumeração dos tenants a vigiar.
--
-- * portfolio_alert: um alerta por (tenant, cliente, ativo, dia de pregão, sentido); o insert é
--   ON CONFLICT DO NOTHING RETURNING e só o que entrou é publicado. trading_day é a data em
--   America/Sao_Paulo (calculada pela aplicação). FK composta (tenant_id, client_id) com cascade,
--   como as demais. Índice para a lista do cliente, mais novo primeiro.
-- * Tabela nova NÃO herda grants (ver 0002): GRANT, ENABLE + FORCE RLS e política explícitos.
--   Política com cliente opcional (como position/import_file): o job lê e grava com só o tenant
--   fixado; a rota lê com o cliente. Só SELECT e INSERT para carina_app: o alerta não muda depois
--   de gravado, e a cascata ao apagar o cliente não depende de grant.
-- * monitor_tenant_ids(): o job roda como carina_app (NOBYPASSRLS) e trata cada tenant sob
--   TenantContext; para saber QUAIS tenants vigiar precisa ler position de todos, o que a RLS
--   proíbe. Mesmo desenho de 0004/0008: função SECURITY DEFINER do carina_migrator que devolve só
--   ids de tenants não suspensos com ao menos uma posição de investimento com código de ativo, e
--   uma política de SELECT em position que vale só quando current_user é carina_migrator e a
--   sessão NÃO é. pg_temp por último no search_path e tabelas qualificadas com public. tenant não
--   tem FORCE (0002): o dono lê suspended_at sem política extra.
--   O código do ativo é normalizado como na leitura do repositório (maiúsculas, sem espaços):
--   um código só de espaços não conta.

CREATE TABLE "portfolio_alert" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "asset_code" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "change_pct" DECIMAL(9,4) NOT NULL,
    "price" DECIMAL(18,6) NOT NULL,
    "trading_day" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_alert_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "portfolio_alert_direction_check" CHECK ("direction" IN ('up', 'down'))
);

CREATE INDEX "portfolio_alert_tenant_id_client_id_created_at_id_idx"
  ON "portfolio_alert"("tenant_id", "client_id", "created_at" DESC, "id" DESC);

CREATE UNIQUE INDEX "portfolio_alert_once_per_day_key"
  ON "portfolio_alert"("tenant_id", "client_id", "asset_code", "trading_day", "direction");

ALTER TABLE "portfolio_alert" ADD CONSTRAINT "portfolio_alert_tenant_id_client_id_fkey"
  FOREIGN KEY ("tenant_id", "client_id")
  REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT ON portfolio_alert TO carina_app;

ALTER TABLE portfolio_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_alert FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_client ON portfolio_alert
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));

-- ─── Tenants a vigiar ───────────────────────────────────────────────────────
CREATE POLICY monitor_scan ON position FOR SELECT TO carina_migrator
  USING (current_user = 'carina_migrator' AND session_user <> 'carina_migrator');

CREATE FUNCTION monitor_tenant_ids()
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT p.tenant_id
    FROM public.position p
    JOIN public.tenant t ON t.id = p.tenant_id
   WHERE t.suspended_at IS NULL
     AND p.kind = 'investment'
     AND p.asset_code IS NOT NULL
     AND upper(regexp_replace(p.asset_code, '\s', '', 'g')) <> ''
$$;
ALTER FUNCTION monitor_tenant_ids() OWNER TO carina_migrator;
REVOKE ALL ON FUNCTION monitor_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitor_tenant_ids() TO carina_app;
