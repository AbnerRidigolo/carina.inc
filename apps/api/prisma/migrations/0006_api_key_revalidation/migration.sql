-- 0006_api_key_revalidation — suspensão de tenant e revalidação da chave por id.
--
-- * tenant.suspended_at: tenant suspenso (não NULL) não autentica mais: resolve_api_key passa a
--   ignorar as chaves dele (REST → 401).
-- * resolve_api_key_by_id(key_id): o mesmo resultado de resolve_api_key, mas pelo id da chave. Usado
--   para revalidar conexões longas (WebSocket do chat) que guardam só o keyId do ticket, nunca a
--   chave nem o hash: chave revogada, tenant suspenso ou chave inexistente → nenhuma linha.
--
-- Isolamento do SECURITY DEFINER (como em 0002): pg_temp por último no search_path e tabelas
-- qualificadas com public., para tabelas temporárias de carina_app não sombrearem as reais.
ALTER TABLE tenant ADD COLUMN suspended_at timestamptz;

CREATE OR REPLACE FUNCTION resolve_api_key(p_hash text)
  RETURNS TABLE(key_id uuid, tenant_id uuid, tenant_name text, scopes text[], rpm int, monthly_quota int)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT k.id, t.id, t.name, k.scopes, t.rpm, t.monthly_quota
  FROM public.api_key k
  JOIN public.tenant t ON t.id = k.tenant_id
  WHERE k.hash = p_hash AND k.revoked_at IS NULL AND t.suspended_at IS NULL
$$;

CREATE FUNCTION resolve_api_key_by_id(p_key_id uuid)
  RETURNS TABLE(key_id uuid, tenant_id uuid, tenant_name text, scopes text[], rpm int, monthly_quota int)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT k.id, t.id, t.name, k.scopes, t.rpm, t.monthly_quota
  FROM public.api_key k
  JOIN public.tenant t ON t.id = k.tenant_id
  WHERE k.id = p_key_id AND k.revoked_at IS NULL AND t.suspended_at IS NULL
$$;
ALTER FUNCTION resolve_api_key_by_id(uuid) OWNER TO carina_migrator;
REVOKE ALL ON FUNCTION resolve_api_key_by_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key_by_id(uuid) TO carina_app;
