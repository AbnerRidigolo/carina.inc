-- 0010_strategy — estratégias declarativas do builder (spec §4, "Dado").
--
-- * strategy: especificação declarativa (nunca código do cliente) que pertence ao TENANT, não a um
--   cliente: sem client_id e sem FK por cliente. FK para tenant com cascade, como usage_record.
-- * CHECKs espelhando o StrategySpecSchema/StrategyNameSchema de @carina/shared: kind do MVP,
--   símbolo no formato de SYMBOL_RE, janelas fast 2..200 e slow 3..400, e fast < slow só para
--   sma_cross (buy_hold ignora as janelas). O nome chega já aparado pelo schema; o banco garante
--   1..120 caracteres e não só espaços.
-- * Limite de 100 estratégias por tenant: imposto pela aplicação (StrategyRepository.create) com
--   pg_advisory_xact_lock por tenant + contagem na mesma transação, para duas criações
--   simultâneas não passarem juntas.
-- * Índice para a lista do tenant, mais nova primeiro.
-- * Tabela nova NÃO herda grants (ver 0002): GRANT, ENABLE + FORCE RLS e política explícitos.
--   Política só por tenant (como usage_record). Só SELECT e INSERT para carina_app: não há rota que
--   altere ou apague estratégia, e a cascata ao apagar o tenant não depende de grant.

CREATE TABLE "strategy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "fast" INTEGER NOT NULL,
    "slow" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "strategy_name_check"
      CHECK (char_length("name") BETWEEN 1 AND 120 AND btrim("name") <> ''),
    CONSTRAINT "strategy_kind_check" CHECK ("kind" IN ('buy_hold', 'sma_cross')),
    CONSTRAINT "strategy_symbol_check" CHECK ("symbol" ~ '^\^?[A-Z0-9]{1,12}$'),
    CONSTRAINT "strategy_fast_check" CHECK ("fast" BETWEEN 2 AND 200),
    CONSTRAINT "strategy_slow_check" CHECK ("slow" BETWEEN 3 AND 400),
    CONSTRAINT "strategy_sma_cross_windows_check" CHECK ("kind" <> 'sma_cross' OR "fast" < "slow")
);

CREATE INDEX "strategy_tenant_id_created_at_id_idx"
  ON "strategy"("tenant_id", "created_at" DESC, "id" DESC);

ALTER TABLE "strategy" ADD CONSTRAINT "strategy_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT ON strategy TO carina_app;

ALTER TABLE strategy ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON strategy
  USING (tenant_id = app_tenant())
  WITH CHECK (tenant_id = app_tenant());
