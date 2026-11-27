-- 0011_aops — procedimentos de agentes (AOPs, spec §4.3–4.4): o procedimento compilado, as execuções
-- por cliente e a enumeração dos tenants a varrer.
--
-- * aop: pertence ao TENANT (como strategy): sem client_id; client_ids guarda os externalIds
--   (1..20) que o job resolve sob o tenant a cada execução — cliente removido vira execução pulada,
--   não FK quebrada. CHECKs espelhando o AopSchema/ScheduleSchema de @carina/shared: nome 1..120,
--   descrição 1..2000, 1..3 agentes dentre os especialistas do chat (sem executor/navigator),
--   agenda nas faixas do schema (hora em America/Sao_Paulo, calculada pela aplicação). Arrays
--   unidimensionais e sem NULL. last_fire_at é o último horário disparado (spec §4.4).
-- * Limite de 50 AOPs por tenant: imposto pela aplicação (AopsRepository.create) com
--   pg_advisory_xact_lock por tenant + contagem na mesma transação, como o builder (0010).
-- * Disparo idempotente: UPDATE aop SET last_fire_at = $fire WHERE id = $id AND enabled AND
--   (last_fire_at IS NULL OR last_fire_at < $fire) RETURNING id — só quem ganha roda; o único
--   (aop_id, client_id, fire_at) de aop_run cobre o resto (réplica concorrente, reentrega).
-- * aop_run: uma linha por (AOP, cliente, horário). client_id é o uuid INTERNO; FKs compostas
--   (tenant_id, client_id) → client e (tenant_id, aop_id) → aop, ambas com cascade: a execução não
--   aponta para cliente ou AOP de outro tenant, e some com eles. CHECKs: status ok ⇔ sem
--   failure_code; work_type só dos valores do WorkTypeSchema; cobrança (work_type e price_brl) só
--   quando executou (ok), nunca em pulado/falho (anti-objetivo "cobrar sem executar"). audit_id
--   sem FK: a auditoria é do Watchtower e o vínculo é só informativo. Índice para o histórico do
--   AOP, mais novo primeiro.
-- * Tabelas novas NÃO herdam grants (ver 0002): GRANT, ENABLE + FORCE RLS e política explícitos.
--   aop: política só por tenant (como strategy); carina_app com SELECT e INSERT, e UPDATE só nas
--   colunas enabled e last_fire_at (GRANT por coluna): o resto não muda depois de criado (spec §2).
--   aop_run: política com cliente opcional (como portfolio_alert); só SELECT e INSERT — a execução
--   não muda depois de gravada, e as cascatas não dependem de grant.
-- * aop_tenant_ids(): o job roda como carina_app (NOBYPASSRLS) e trata cada tenant sob
--   TenantContext; para saber QUAIS tenants varrer precisa ler aop de todos, o que a RLS proíbe.
--   Mesmo desenho de 0009 (monitor_tenant_ids): função SECURITY DEFINER do carina_migrator que
--   devolve só ids de tenants não suspensos com ao menos um AOP habilitado, e uma política de SELECT
--   em aop que vale só quando current_user é carina_migrator e a sessão NÃO é. pg_temp por último no
--   search_path e tabelas qualificadas com public. tenant não tem FORCE (0002).

CREATE TABLE "aop" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "agents" TEXT[] NOT NULL,
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "hour" INTEGER NOT NULL,
    "client_ids" TEXT[] NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_fire_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aop_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aop_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
    CONSTRAINT "aop_description_check" CHECK (char_length("description") BETWEEN 1 AND 2000),
    CONSTRAINT "aop_agents_check" CHECK (
      array_ndims("agents") = 1
      AND cardinality("agents") BETWEEN 1 AND 3
      AND array_position("agents", NULL) IS NULL
      AND "agents" <@ ARRAY['insight', 'predictor', 'risk', 'strategist', 'tax', 'researcher',
                            'assessor_liaison']::TEXT[]
    ),
    CONSTRAINT "aop_client_ids_check" CHECK (
      array_ndims("client_ids") = 1
      AND cardinality("client_ids") BETWEEN 1 AND 20
      AND array_position("client_ids", NULL) IS NULL
    ),
    CONSTRAINT "aop_frequency_check" CHECK ("frequency" IN ('daily', 'weekly', 'monthly')),
    CONSTRAINT "aop_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6),
    CONSTRAINT "aop_day_check" CHECK ("day" BETWEEN 1 AND 28),
    CONSTRAINT "aop_hour_check" CHECK ("hour" BETWEEN 0 AND 23)
);

-- alvo da FK composta de aop_run
CREATE UNIQUE INDEX "aop_tenant_id_id_key" ON "aop"("tenant_id", "id");

CREATE INDEX "aop_tenant_id_created_at_id_idx" ON "aop"("tenant_id", "created_at" DESC, "id" DESC);

ALTER TABLE "aop" ADD CONSTRAINT "aop_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "aop_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "aop_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "fire_at" TIMESTAMPTZ(6) NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failure_code" TEXT,
    "results" JSONB NOT NULL DEFAULT '{}',
    "work_type" TEXT,
    "price_brl" DECIMAL(18,2),
    "audit_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aop_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "aop_run_trigger_check" CHECK ("trigger" IN ('schedule', 'manual')),
    CONSTRAINT "aop_run_status_check" CHECK ("status" IN ('ok', 'failed', 'skipped')),
    CONSTRAINT "aop_run_failure_code_check"
      CHECK ("failure_code" IN ('client_not_found', 'quota_exceeded', 'agents_failed')),
    CONSTRAINT "aop_run_outcome_check" CHECK (("status" = 'ok') = ("failure_code" IS NULL)),
    CONSTRAINT "aop_run_charge_check" CHECK (
      CASE WHEN "status" = 'ok' THEN "work_type" IS NOT NULL AND "price_brl" IS NOT NULL
           ELSE "work_type" IS NULL AND "price_brl" IS NULL END
    ),
    CONSTRAINT "aop_run_price_brl_check" CHECK ("price_brl" >= 0),
    -- Espelha o WorkTypeSchema de @carina/shared (NULL passa: pulado/falho não cobra).
    CONSTRAINT "aop_run_work_type_check" CHECK ("work_type" IN (
      'query', 'analysis', 'multi_agent_analysis', 'optimization', 'execution', 'data_query',
      'data_ingestion', 'evaluation', 'backtest'
    )),
    CONSTRAINT "aop_run_results_check" CHECK (jsonb_typeof("results") = 'object')
);

-- um disparo por AOP, cliente e horário
CREATE UNIQUE INDEX "aop_run_once_key" ON "aop_run"("aop_id", "client_id", "fire_at");

CREATE INDEX "aop_run_tenant_id_aop_id_created_at_id_idx"
  ON "aop_run"("tenant_id", "aop_id", "created_at" DESC, "id" DESC);

-- cascata ao apagar o cliente
CREATE INDEX "aop_run_tenant_id_client_id_idx" ON "aop_run"("tenant_id", "client_id");

ALTER TABLE "aop_run" ADD CONSTRAINT "aop_run_tenant_id_aop_id_fkey"
  FOREIGN KEY ("tenant_id", "aop_id")
  REFERENCES "aop"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "aop_run" ADD CONSTRAINT "aop_run_tenant_id_client_id_fkey"
  FOREIGN KEY ("tenant_id", "client_id")
  REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Grants e RLS ───────────────────────────────────────────────────────────
GRANT SELECT, INSERT ON aop TO carina_app;
GRANT UPDATE ("enabled", "last_fire_at") ON aop TO carina_app;

ALTER TABLE aop ENABLE ROW LEVEL SECURITY;
ALTER TABLE aop FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON aop
  USING (tenant_id = app_tenant())
  WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT ON aop_run TO carina_app;

ALTER TABLE aop_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE aop_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_client ON aop_run
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));

-- ─── Tenants a varrer ───────────────────────────────────────────────────────
CREATE POLICY aop_scan ON aop FOR SELECT TO carina_migrator
  USING (current_user = 'carina_migrator' AND session_user <> 'carina_migrator');

CREATE FUNCTION aop_tenant_ids()
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT a.tenant_id
    FROM public.aop a
    JOIN public.tenant t ON t.id = a.tenant_id
   WHERE t.suspended_at IS NULL
     AND a.enabled
$$;
ALTER FUNCTION aop_tenant_ids() OWNER TO carina_migrator;
REVOKE ALL ON FUNCTION aop_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aop_tenant_ids() TO carina_app;
