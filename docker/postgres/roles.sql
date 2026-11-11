-- Papéis do CARINA. Fonte única, usada por:
--   * docker/postgres/init.sh (psql -v migrator_pw=… -v app_pw=…);
--   * apps/api/test/setup/global-setup.ts, que troca os placeholders pelos literais escapados
--     pelo driver pg antes de executar.
-- Roda como superusuário. Idempotente: papéis são do cluster inteiro, então o script cria o que
-- falta e (re)aplica atributos e senhas do que já existe.
--
-- O psql não interpola variáveis dentro de $$…$$, por isso as senhas passam por set_config e são
-- lidas no bloco DO com current_setting (e quotadas com format('%L')).
-- `SELECT FROM set_config(…)` não devolve colunas, para as senhas não irem para o log do psql.

SELECT FROM set_config('carina.migrator_pw', :'migrator_pw', false);
SELECT FROM set_config('carina.app_pw', :'app_pw', false);

DO $$
BEGIN
  -- Serializa execuções concorrentes (ex.: dois harnesses de teste no mesmo cluster).
  PERFORM pg_advisory_xact_lock(hashtext('carina_roles'));

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'carina_migrator') THEN
    CREATE ROLE carina_migrator;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'carina_app') THEN
    CREATE ROLE carina_app;
  END IF;

  -- Dono do schema e das tabelas; roda as migrações. Sujeito à RLS nas tabelas com FORCE.
  EXECUTE format(
    'ALTER ROLE carina_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD %L',
    current_setting('carina.migrator_pw'));
  -- Papel de runtime (API e workers): nunca superusuário, nunca ignora a RLS.
  EXECUTE format(
    'ALTER ROLE carina_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
    current_setting('carina.app_pw'));
END
$$;

SELECT FROM set_config('carina.migrator_pw', '', false);
SELECT FROM set_config('carina.app_pw', '', false);
