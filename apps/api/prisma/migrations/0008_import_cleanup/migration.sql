-- 0008_import_cleanup — enumeração de tenants com importação a limpar (spec §5.6).
--
-- A limpeza periódica da importação roda como carina_app (NOBYPASSRLS) e trata cada tenant sob
-- TenantContext. Para saber QUAIS tenants têm o que limpar, precisa ler import_file e import_job
-- de todos os tenants, o que a RLS proíbe. Como em 0004 (active_tenant_ids), uma função SECURITY
-- DEFINER devolve só ids de tenants com ao menos:
--   * um import_file criado antes de p_files_before (arquivo temporário vencido); ou
--   * um import_job em 'parsing' com progress_at antes de p_stuck_before (job parado).
--
-- Mesmo desenho de 0004: as políticas de SELECT abaixo valem só quando current_user é
-- carina_migrator e a sessão NÃO é (dentro de uma função SECURITY DEFINER do migrator chamada
-- pela aplicação). pg_temp por último no search_path e tabelas qualificadas com public.
CREATE POLICY import_cleanup_scan ON import_file FOR SELECT TO carina_migrator
  USING (current_user = 'carina_migrator' AND session_user <> 'carina_migrator');
CREATE POLICY import_cleanup_scan ON import_job FOR SELECT TO carina_migrator
  USING (current_user = 'carina_migrator' AND session_user <> 'carina_migrator');

CREATE INDEX "import_job_status_progress_at_idx" ON "import_job"("status", "progress_at");

CREATE FUNCTION import_cleanup_tenant_ids(p_files_before timestamptz, p_stuck_before timestamptz)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT f.tenant_id FROM public.import_file f WHERE f.created_at < p_files_before
  UNION
  SELECT j.tenant_id FROM public.import_job j
   WHERE j.status = 'parsing' AND j.progress_at < p_stuck_before
$$;
ALTER FUNCTION import_cleanup_tenant_ids(timestamptz, timestamptz) OWNER TO carina_migrator;
REVOKE ALL ON FUNCTION import_cleanup_tenant_ids(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_cleanup_tenant_ids(timestamptz, timestamptz) TO carina_app;
