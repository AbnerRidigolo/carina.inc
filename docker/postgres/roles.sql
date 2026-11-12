-- Papéis do CARINA. Fonte única, usada por:
--   * docker/postgres/init.sh (psql -v migrator_pw=… -v app_pw=…);
--   * apps/api/test/setup/global-setup.ts, que troca os placeholders pelos literais escapados
--     pelo driver pg antes de executar.
-- Roda como superusuário. Papéis são do cluster inteiro, então o script só CRIA os que faltam
-- (com as senhas recebidas) e NUNCA altera papéis existentes: senha e atributos de um papel já
-- criado continuam como estão. Se um papel existente tiver atributos perigosos (superusuário,
-- BYPASSRLS, sem LOGIN), o script falha em vez de corrigi-lo.
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

  -- Dono do schema e das tabelas; roda as migrações. Sujeito à RLS nas tabelas com FORCE.
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'carina_migrator') THEN
    EXECUTE format(
      'CREATE ROLE carina_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD %L',
      current_setting('carina.migrator_pw'));
  END IF;
  -- Papel de runtime (API e workers): nunca superusuário, nunca ignora a RLS.
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'carina_app') THEN
    EXECUTE format(
      'CREATE ROLE carina_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
      current_setting('carina.app_pw'));
  END IF;

  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname IN ('carina_migrator', 'carina_app')
             AND (rolsuper OR rolbypassrls OR NOT rolcanlogin)) THEN
    RAISE EXCEPTION 'carina_migrator/carina_app já existem com SUPERUSER, BYPASSRLS ou sem LOGIN'
      USING HINT = 'Corrija os papéis manualmente (ALTER ROLE … LOGIN NOSUPERUSER NOBYPASSRLS); '
                   'este script não altera papéis existentes.';
  END IF;
END
$$;

SELECT FROM set_config('carina.migrator_pw', '', false);
SELECT FROM set_config('carina.app_pw', '', false);
