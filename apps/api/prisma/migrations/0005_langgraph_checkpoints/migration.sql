-- 0005_langgraph_checkpoints — tabelas de checkpoint do LangGraph (SQL escrito à mão).
--
-- Roda como carina_migrator. Reproduz o estado final das migrações v0..v5 do
-- `PostgresSaver.setup()` de @langchain/langgraph-checkpoint-postgres 1.1.2 (versão fixada) no
-- schema `langgraph` criado na 0002, e registra essas versões em `checkpoint_migrations`.
--
-- Por que não `setup()` em runtime: ele roda `CREATE SCHEMA IF NOT EXISTS`, que exige CREATE no
-- BANCO (o carina_app não tem), e DDL não deve partir do papel da aplicação. O app só confere a
-- versão no boot (CarinaCheckpointer.setup). O teste de paridade (checkpointer.int.spec) compara
-- estas tabelas com as criadas pelo `setup()` original; ao subir a biblioteca, rode-o e escreva a
-- migração seguinte.
--
-- Sem RLS (tabelas da biblioteca): o isolamento entre tenants é o prefixo `tenantId:clientId:` do
-- thread_id, conferido pela aplicação antes de qualquer leitura ou retomada (thread-id.ts).
-- Menor privilégio: o CREATE no schema dado na 0002 (para o setup() da biblioteca) é revogado.

CREATE TABLE langgraph.checkpoint_migrations (
  v INTEGER PRIMARY KEY
);

CREATE TABLE langgraph.checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE langgraph.checkpoint_blobs (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  blob BYTEA,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE langgraph.checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  blob BYTEA NOT NULL,
  task_path TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

INSERT INTO langgraph.checkpoint_migrations (v) VALUES (0), (1), (2), (3), (4), (5);

REVOKE CREATE ON SCHEMA langgraph FROM carina_app;
GRANT SELECT ON langgraph.checkpoint_migrations TO carina_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  langgraph.checkpoints, langgraph.checkpoint_blobs, langgraph.checkpoint_writes
TO carina_app;
