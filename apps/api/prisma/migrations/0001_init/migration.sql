-- 0001_init — gerada por `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
-- e editada à mão onde o Prisma não expressa o modelo (marcado com "EDITADO À MÃO"):
--   * kg_chunk.tsv como coluna gerada (to_tsvector('portuguese', content));
--   * CREATE EXTENSION IF NOT EXISTS vector (só confirma; ver abaixo);
--   * índices HNSW (vector_cosine_ops) nos embeddings;
--   * FKs compostas com client_id/chunk_id opcional (MATCH SIMPLE: só valem quando preenchidos),
--     com ON DELETE SET NULL só na coluna opcional (PostgreSQL 15+).

-- EDITADO À MÃO: pgvector não é extensão confiável e carina_migrator não é superusuário, então a
-- extensão é criada antes pelo superusuário (docker/postgres/init.sh e o global-setup dos
-- testes); aqui o IF NOT EXISTS só a confirma. Num banco sem ela, o erro é explícito
-- ("permission denied to create extension"), e um shadow database de superusuário a cria.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "rpm" INTEGER NOT NULL DEFAULT 60,
    "monthly_quota" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[],
    "label" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_request" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "thread_id" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "value_brl" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by_key_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executed_action" (
    "approval_request_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "executed_action_pkey" PRIMARY KEY ("approval_request_id")
);

-- CreateTable
CREATE TABLE "usage_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "work_type" TEXT NOT NULL,
    "agents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "price_brl" DECIMAL(18,2) NOT NULL,
    "fee_brl" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "value_brl" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "channel" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "agents" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "response_digest" TEXT,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "asset_class" TEXT NOT NULL,
    "asset_code" TEXT,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(24,8),
    "value_brl" DECIMAL(18,2) NOT NULL,
    "as_of" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount_brl" DECIMAL(18,2) NOT NULL,
    "category" TEXT,
    "kind" TEXT NOT NULL,
    "asset_code" TEXT,
    "quantity" DECIMAL(24,8),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "format" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_document" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kg_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_chunk" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    -- EDITADO À MÃO: coluna gerada (o Prisma só a vê como Unsupported("tsvector")).
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', "content")) STORED,

    CONSTRAINT "kg_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_entity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1024),

    CONSTRAINT "kg_entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_relation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "chunk_id" UUID,

    CONSTRAINT "kg_relation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_mention" (
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,

    CONSTRAINT "kg_mention_pkey" PRIMARY KEY ("chunk_id","entity_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_key_hash_key" ON "api_key"("hash");

-- CreateIndex
CREATE INDEX "api_key_tenant_id_idx" ON "api_key"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_tenant_id_external_id_key" ON "client"("tenant_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_tenant_id_id_key" ON "client"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "approval_request_tenant_id_client_id_idx" ON "approval_request"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "approval_request_status_expires_at_idx" ON "approval_request"("status", "expires_at");

-- CreateIndex
CREATE INDEX "executed_action_tenant_id_client_id_idx" ON "executed_action"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "usage_record_tenant_id_created_at_idx" ON "usage_record"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_created_at_idx" ON "audit_event"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "position_tenant_id_client_id_idx" ON "position"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "position_tenant_id_client_id_source_external_id_key" ON "position"("tenant_id", "client_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "transaction_tenant_id_client_id_idx" ON "transaction"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "transaction_tenant_id_client_id_source_external_id_key" ON "transaction"("tenant_id", "client_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "import_job_tenant_id_client_id_idx" ON "import_job"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_job_tenant_id_client_id_file_sha256_key" ON "import_job"("tenant_id", "client_id", "file_sha256");

-- CreateIndex
CREATE INDEX "kg_document_tenant_id_client_id_idx" ON "kg_document"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "kg_document_tenant_id_client_id_id_key" ON "kg_document"("tenant_id", "client_id", "id");

-- CreateIndex
CREATE INDEX "kg_chunk_tenant_id_client_id_idx" ON "kg_chunk"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "kg_chunk_tenant_id_client_id_document_id_idx" ON "kg_chunk"("tenant_id", "client_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "kg_chunk_tenant_id_client_id_id_key" ON "kg_chunk"("tenant_id", "client_id", "id");

-- EDITADO À MÃO: índices vetoriais (HNSW, distância de cosseno). O GIN do tsv também está
-- declarado no schema (@@index type: Gin).
CREATE INDEX "kg_chunk_embedding_hnsw_idx" ON "kg_chunk" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "kg_entity_embedding_hnsw_idx" ON "kg_entity" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "kg_chunk_tsv_idx" ON "kg_chunk" USING GIN ("tsv");

-- CreateIndex
CREATE INDEX "kg_entity_tenant_id_client_id_idx" ON "kg_entity"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "kg_entity_tenant_id_client_id_type_name_key" ON "kg_entity"("tenant_id", "client_id", "type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "kg_entity_tenant_id_client_id_id_key" ON "kg_entity"("tenant_id", "client_id", "id");

-- CreateIndex
CREATE INDEX "kg_relation_tenant_id_client_id_idx" ON "kg_relation"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "kg_relation_tenant_id_client_id_source_id_idx" ON "kg_relation"("tenant_id", "client_id", "source_id");

-- CreateIndex
CREATE INDEX "kg_relation_tenant_id_client_id_target_id_idx" ON "kg_relation"("tenant_id", "client_id", "target_id");

-- CreateIndex
CREATE INDEX "kg_mention_tenant_id_client_id_idx" ON "kg_mention"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "kg_mention_tenant_id_client_id_entity_id_idx" ON "kg_mention"("tenant_id", "client_id", "entity_id");

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_decided_by_key_id_fkey" FOREIGN KEY ("decided_by_key_id") REFERENCES "api_key"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executed_action" ADD CONSTRAINT "executed_action_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executed_action" ADD CONSTRAINT "executed_action_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- EDITADO À MÃO: composta, para o uso não apontar para cliente de outro tenant.
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE SET NULL ("client_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- EDITADO À MÃO: composta, para a auditoria não apontar para cliente de outro tenant.
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE SET NULL ("client_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position" ADD CONSTRAINT "position_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_document" ADD CONSTRAINT "kg_document_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_chunk" ADD CONSTRAINT "kg_chunk_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_chunk" ADD CONSTRAINT "kg_chunk_tenant_id_client_id_document_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "document_id") REFERENCES "kg_document"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entity" ADD CONSTRAINT "kg_entity_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_tenant_id_client_id_source_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "source_id") REFERENCES "kg_entity"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_tenant_id_client_id_target_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "target_id") REFERENCES "kg_entity"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- EDITADO À MÃO: composta, para a relação só citar chunk do mesmo tenant e cliente.
ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_tenant_id_client_id_chunk_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "chunk_id") REFERENCES "kg_chunk"("tenant_id", "client_id", "id") ON DELETE SET NULL ("chunk_id") ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_mention" ADD CONSTRAINT "kg_mention_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_mention" ADD CONSTRAINT "kg_mention_tenant_id_client_id_chunk_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "chunk_id") REFERENCES "kg_chunk"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_mention" ADD CONSTRAINT "kg_mention_tenant_id_client_id_entity_id_fkey" FOREIGN KEY ("tenant_id", "client_id", "entity_id") REFERENCES "kg_entity"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
