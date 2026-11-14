-- 0004_reconciliation — enumeração de tenants com trabalho pendente para o job de reconciliação.
--
-- O job roda como carina_app (NOBYPASSRLS) e processa cada tenant sob TenantContext. Para saber
-- QUAIS tenants têm trabalho, precisa ler as tabelas de todos os tenants, o que a RLS proíbe.
-- Em vez de dar o papel migrator à aplicação, esta função SECURITY DEFINER devolve só ids de
-- tenants que têm ao menos uma linha não terminal:
--   * approval_request pending;
--   * approval_request approved sem executed_action;
--   * executed_action started.
--
-- O dono (carina_migrator) também está sujeito à RLS (FORCE). Por isso as duas tabelas ganham uma
-- política de SELECT que vale só quando current_user é carina_migrator mas a sessão (session_user)
-- NÃO é: isso só acontece dentro de uma função SECURITY DEFINER do migrator chamada por outro
-- login (a API, como carina_app). Quem conecta direto como migrator (migrações, testes) continua
-- sob a RLS normal. carina_app não é afetado: a política não vale para o papel dele, e ele não
-- consegue assumir o papel carina_migrator (sem SET ROLE).
--
-- Isolamento do SECURITY DEFINER (como resolve_api_key): pg_temp por último no search_path e
-- tabelas qualificadas com public., para tabelas temporárias de carina_app não sombrearem as reais.
CREATE POLICY reconciliation_scan ON approval_request FOR SELECT TO carina_migrator
  USING (current_user = 'carina_migrator' AND session_user <> 'carina_migrator');
CREATE POLICY reconciliation_scan ON executed_action FOR SELECT TO carina_migrator
  USING (current_user = 'carina_migrator' AND session_user <> 'carina_migrator');

CREATE FUNCTION active_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT a.tenant_id FROM public.approval_request a WHERE a.status = 'pending'
  UNION
  SELECT a.tenant_id FROM public.approval_request a
   WHERE a.status = 'approved'
     AND NOT EXISTS (SELECT 1 FROM public.executed_action e WHERE e.approval_request_id = a.id)
  UNION
  SELECT e.tenant_id FROM public.executed_action e WHERE e.status = 'started'
$$;
ALTER FUNCTION active_tenant_ids() OWNER TO carina_migrator;
REVOKE ALL ON FUNCTION active_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION active_tenant_ids() TO carina_app;
