-- 0007_imports — importação de arquivos: opções, motivo de falha, progresso e bytes temporários.
--
-- * import_job.options: opções do envio (mapeamento do CSV etc.); failure_code: código fixo do
--   motivo da falha (nunca conteúdo do arquivo); progress_at: último avanço do parse (a limpeza
--   marca como 'stuck' o job em 'parsing' sem progresso há mais de 15 min).
-- * CHECKs de status e formato; UNIQUE (tenant_id, client_id, id) como alvo da FK composta.
-- * import_file: bytes do arquivo enviado, só até o parse fechar o job (a mesma transação os apaga;
--   a limpeza apaga o que passar de 1 h). Limite de 10 MB também no banco.
-- Tabela nova NÃO herda grants (ver 0002): GRANT, ENABLE + FORCE RLS e política explícitos.

ALTER TABLE import_job
  ADD COLUMN options jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN failure_code text,
  ADD COLUMN progress_at timestamptz(6) NOT NULL DEFAULT now();

ALTER TABLE import_job
  ADD CONSTRAINT import_job_status_check CHECK (status IN ('queued', 'parsing', 'done', 'failed')),
  ADD CONSTRAINT import_job_format_check CHECK (format IN ('ofx', 'csv', 'b3_xlsx'));

CREATE UNIQUE INDEX "import_job_tenant_id_client_id_id_key" ON "import_job"("tenant_id", "client_id", "id");

CREATE TABLE "import_file" (
    "import_job_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "bytes" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_file_pkey" PRIMARY KEY ("import_job_id"),
    CONSTRAINT "import_file_bytes_size_check" CHECK (octet_length("bytes") <= 10485760)
);

CREATE INDEX "import_file_created_at_idx" ON "import_file"("created_at");

ALTER TABLE "import_file" ADD CONSTRAINT "import_file_import_job_fkey"
  FOREIGN KEY ("tenant_id", "client_id", "import_job_id")
  REFERENCES "import_job"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON import_file TO carina_app;

ALTER TABLE import_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_client ON import_file
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));
