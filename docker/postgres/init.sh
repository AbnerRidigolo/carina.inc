#!/usr/bin/env bash
# Inicialização do Postgres do docker compose (roda uma vez, com o volume vazio, como superusuário).
# O entrypoint da imagem oficial não repassa variáveis do psql para arquivos .sql, então este script
# lê as senhas do ambiente e chama o psql com -v.
set -euo pipefail

: "${CARINA_MIGRATOR_PASSWORD:?defina CARINA_MIGRATOR_PASSWORD}"
: "${CARINA_APP_PASSWORD:?defina CARINA_APP_PASSWORD}"

ROLES_SQL="${CARINA_ROLES_SQL:-/opt/carina/roles.sql}"
PSQL=(psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc --username "$POSTGRES_USER")

"${PSQL[@]}" --dbname postgres \
  -v migrator_pw="$CARINA_MIGRATOR_PASSWORD" \
  -v app_pw="$CARINA_APP_PASSWORD" \
  -f "$ROLES_SQL"

# Banco da aplicação com dono carina_migrator (o schema public, dono pg_database_owner, segue).
"${PSQL[@]}" --dbname postgres <<'SQL'
SELECT 'CREATE DATABASE carina OWNER carina_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'carina')
\gexec
SQL

# pgvector não é extensão confiável: precisa ser criada pelo superusuário.
"${PSQL[@]}" --dbname carina -c 'CREATE EXTENSION IF NOT EXISTS vector'
