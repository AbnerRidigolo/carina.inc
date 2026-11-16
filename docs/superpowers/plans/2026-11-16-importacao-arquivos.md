# Importação de arquivos (entrega 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload de OFX, CSV e XLSX da Área do Investidor B3 que vira posições e transações do cliente final, processado no worker, com progresso pelo WebSocket e tela na web.

**Architecture:** Um módulo novo `apps/api/src/modules/imports` com parsers puros (`bytes → itens normalizados + erros por linha`), um `ImportsService`/controller na API (valida, grava `import_job` + `import_file` sob RLS, publica `import.requested`) e um `ImportWorker` no processo de workers (claim atômico, parse, grava pelo `IngestionService`, apaga os bytes, publica progresso em `inbox.events`). O `InboxBroadcast` existente leva o progresso aos sockets do mesmo tenant e cliente; a web ganha um painel de importação.

**Tech Stack:** NestJS 12 ESM (platform-express + multer), Prisma 7 com RLS, Zod 4 (`packages/shared`), Redis Streams, `fflate` (unzip com tamanhos checáveis antes de descompactar), `fast-xml-parser` (sem entidades), Vitest unit/int/e2e, React + Vite.

**Spec:** `docs/superpowers/specs/2026-11-16-importacao-arquivos-design.md`

## Global Constraints

- Limites (spec §5.2/§5.7): upload ≤ **10 MB** (`10 * 1024 * 1024` bytes); ≤ **5** jobs `queued`/`parsing` por cliente; XLSX ≤ **50 MB** descompactado somado, ≤ **50** entradas no zip; OFX/CSV ≤ **100 000** linhas, ≤ **64** colunas, linha ≤ **64 KB**; parse ≤ **30 s**; posições por arquivo ≤ **1000**; `errors` guardados ≤ **100** (com a contagem total em `stats.errorRows`); `fileName` ≤ **120** caracteres.
- Limpeza: `import_file` com mais de **1 h** → apagada e job `failed` (`expired`); job `parsing` sem progresso há mais de **15 min** → `failed` (`stuck`).
- Cobrança: cada lote gravado (até **1000** itens) é um `data_ingestion` de **R$ 0,05**, pelo `IngestionService` (lote gravado ⇔ lote cobrado). Recusas síncronas e reenvio de arquivo já processado não cobram.
- LGPD: nenhum conteúdo de linha, valor, descrição ou nome de arquivo em log, erro de linha, auditoria ou evento de stream. Erro de linha = `{ row, field?, code, message }` com `message` fixa por `code`. Os bytes saem do banco na mesma transação que fecha o job.
- `source` das linhas importadas: `"import"`. `:clientId` nas rotas é o `externalId` do tenant (como na ingestão).
- Nada é "chutado": separador decimal e formato de data do CSV vêm do mapeamento; valor ou data ambíguos → erro de linha.
- Dependências novas com versão exata (sem `^`), como o resto do `package.json`.
- Cada tarefa roda, antes do commit: `pnpm lint`, `pnpm typecheck`, testes unitários do pacote, e `test:int` + `test:e2e` completos nas duas collations (`TEST_DB_ICU_LOCALE=en-US` e sem), com cobertura ≥ 80% mantida.
- Mensagens ao usuário, comentários e docs em português, no tom do resto do repositório.
- Redis de teste: `imports/imports.int.spec.ts` → DB **15** em `int`; `imports/imports.e2e.spec.ts` → DB **7** em `e2e` (`test/setup/redis-dbs.ts`).

## Review Focus

1. **Extrato sobreposto** (o mesmo OFX/CSV de outubro reenviado dentro de um de outubro+novembro, com bytes diferentes): nenhuma transação duplicada. → Task 4 e Task 5 (teste "extrato sobreposto não duplica").
2. **CSV de outro banco com vírgula decimal e milhar com ponto** (`1.234,56`) sob mapeamento `decimal: "comma"`: vira `1234.56`, e `1,234.56` sob o mesmo mapeamento vira erro de linha, não `1.23`. → Task 5.
3. **Worker cai no meio do arquivo** (lotes 1 e 2 gravados, 3 não): o job termina `failed` (`stuck` pela limpeza), e reenviar o mesmo arquivo reprocessa sem duplicar e sem cobrar o lote 1 duas vezes além do upsert. → Task 9 e Task 10 (teste "reenvio após stuck").
4. **Fotografia da B3 mais antiga enviada depois de uma mais nova**: nada é substituído e as linhas entram como `stale_snapshot`. → Task 8.
5. **Arquivo com nome hostil** (`../../etc/passwd`, RTL override, 10 KB de nome): `fileName` guardado só como nome-base limpo e truncado, nunca usado como caminho. → Task 9.

---

### Task 1: Contratos compartilhados da importação

**Files:**
- Create: `packages/shared/src/imports.ts`, `packages/shared/src/imports.spec.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/ingestion.ts` (eventos de stream), `packages/shared/src/chat.ts` (eventos do WebSocket), specs correspondentes

**Interfaces:**
- Produces:
  - `ImportFormatSchema = z.enum(["ofx", "csv", "b3_xlsx"])`, `type ImportFormat`
  - `ImportStatusSchema = z.enum(["queued", "parsing", "done", "failed"])`
  - `CsvMappingSchema`: `{ date: string; amount: string; description: string; kind?: string; category?: string; externalId?: string; dateFormat: "dd/MM/yyyy" | "yyyy-MM-dd"; decimal: "comma" | "dot"; delimiter?: ";" | "," }` (nomes de coluna 1..120 caracteres, `.strict()`)
  - `CsvPresetSchema = z.enum(["nubank_conta", "generico_br"])`
  - `ImportOptionsSchema`: união por formato, `.strict()`:
    - `{ format: "ofx" }`
    - `{ format: "csv"; institution: string; account: string; csvPreset?: CsvPreset; csvMapping?: CsvMapping }` com refine "exatamente um de `csvPreset`/`csvMapping`"; `institution`/`account` 1..80 caracteres, sem `\p{C}`
    - `{ format: "b3_xlsx"; asOf?: string /* YYYY-MM-DD */ }`
  - `ImportUploadFieldsSchema`: os campos multipart como texto (`format?`, `institution?`, `account?`, `csvPreset?`, `csvMapping?` (JSON em texto), `asOf?`), usado pelo controller antes de montar `ImportOptions`
  - `ImportRowErrorSchema = { row: number; field?: string; code: string; message: string }`
  - `ImportStatsSchema = { rowsRead: number; positions: number; transactions: number; errorRows: number; ignored: Record<string, number> }`
  - `ImportFailureCodeSchema = z.enum(["unreadable", "no_valid_rows", "limit_exceeded", "unsupported_ofx_investment", "missing_as_of", "expired", "stuck", "internal"])`
  - `ImportJobViewSchema = { id: uuid; format; fileName; status; failureCode: ImportFailureCode | null; stats; errors: ImportRowError[] (≤100); createdAt; updatedAt }`
  - `ImportJobListSchema = { items: ImportJobView[]; nextCursor: string | null }`
  - Em `StreamEventSchema`: `import.requested { importJobId }`, `import.progress { importJobId, stage: "parsing" | "writing", processed: number, total: number }`, `import.finished { importJobId, status: "done" | "failed" }`
  - Em `ChatEventSchema`: `import_progress { importJobId, stage, processed, total }` e `import_finished { importJobId, status }`

- [ ] **Step 1: Write the failing tests** em `imports.spec.ts`: `ImportOptionsSchema` aceita cada formato válido; recusa CSV com preset E mapeamento, CSV sem nenhum, CSV sem `account`, `institution` com `‮`, `asOf` `"2026-02-30"`, campo extra; `CsvMappingSchema` recusa `decimal: "auto"`; `ImportJobViewSchema` recusa `errors` com 101 itens. Em `ingestion.spec.ts`/`chat.spec.ts`: os três eventos de stream e os dois `ChatEvent` validam e um `stage: "x"` não.
- [ ] **Step 2: Run** `pnpm --filter @carina/shared test` → FAIL (módulo inexistente).
- [ ] **Step 3: Implement** os schemas acima em `imports.ts` e as extensões das uniões.
- [ ] **Step 4: Run** `pnpm --filter @carina/shared test` e `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(shared): contratos da importação de arquivos`

### Task 2: Migração `0007_imports` (opções, motivo de falha e bytes temporários)

**Files:**
- Create: `apps/api/prisma/migrations/0007_imports/migration.sql`
- Modify: `apps/api/prisma/schema.prisma` (model `ImportJob`, novo `ImportFile`), `apps/api/test/database/migrations.int.spec.ts`, `apps/api/test/database/rls-isolation.int.spec.ts`

**Interfaces:**
- Produces:
  - `import_job.options jsonb NOT NULL DEFAULT '{}'`, `import_job.failure_code text NULL`, `import_job.progress_at timestamptz NOT NULL DEFAULT now()` (Prisma: `options Json`, `failureCode String?`, `progressAt DateTime`)
  - CHECK `import_job.status IN ('queued','parsing','done','failed')` e `format IN ('ofx','csv','b3_xlsx')`
  - Tabela `import_file (import_job_id uuid PK, tenant_id uuid, client_id uuid, bytes bytea NOT NULL, created_at timestamptz DEFAULT now())`, FK `(tenant_id, client_id, import_job_id)` → `import_job(tenant_id, client_id, id)` `ON DELETE CASCADE` (adicionar o UNIQUE `(tenant_id, client_id, id)` em `import_job` se faltar), CHECK `octet_length(bytes) <= 10485760`, índice em `created_at`
  - RLS em `import_file` igual à de `import_job` (ENABLE + FORCE, política `tenant_client` do `0002_rls`), grants ao `carina_app` iguais aos de `import_job`
  - Prisma: `model ImportFile` (`@@map("import_file")`)

- [ ] **Step 1: Write the failing tests**: em `migrations.int.spec.ts` — as colunas novas existem com os defaults; `status = 'x'` e `format = 'pdf'` são recusados (23514); bytes > 10 MB recusados; apagar o `import_job` apaga o `import_file`. Em `rls-isolation.int.spec.ts` — `import_file` de outro tenant (e de outro cliente com cliente fixado) é invisível para SELECT/DELETE, e INSERT com `tenant_id` alheio falha.
- [ ] **Step 2: Run** `pnpm --filter @carina/api test:int -- test/database` → FAIL.
- [ ] **Step 3: Implement** a migração e o schema Prisma; `pnpm --filter @carina/api prisma:generate`.
- [ ] **Step 4: Run** `test:int` completo nas duas collations → PASS.
- [ ] **Step 5: Commit** `feat(db): import_job com opções e motivo de falha; import_file temporário sob RLS`

### Task 3: Base dos parsers: detecção de formato, decodificação, limites e chaves derivadas

**Files:**
- Create: `apps/api/src/modules/imports/parsers/types.ts`, `detect.ts`, `decode.ts`, `external-id.ts`, `row-errors.ts`, e os `*.spec.ts` ao lado
- Create: `apps/api/test/fixtures/imports/README.md` (diz que todas as fixtures são sintéticas, reconstruídas da documentação pública, sem dado real)

**Interfaces:**
- Produces:
  - `types.ts`: `interface ParseResult { positions: NormalizedPosition[]; transactions: NormalizedTransaction[]; errors: ImportRowError[]; stats: ImportStats; failure?: ImportFailureCode }` (com `failure` o arquivo inteiro falhou; listas vazias); `class ImportLimitError extends Error { code: "limit_exceeded" }`; `PARSE_LIMITS = { maxRows: 100_000, maxColumns: 64, maxLineBytes: 65_536, maxUnzippedBytes: 52_428_800, maxZipEntries: 50, maxPositions: 1000, maxStoredErrors: 100, parseTimeoutMs: 30_000 }`
  - `detect.ts`: `detectFormat(bytes: Uint8Array): ImportFormat | null` (OFX: `OFXHEADER:` nos primeiros 1 KB após BOM/espaços, ou `<?OFX`/`<OFX>`; XLSX: `PK\x03\x04` e, pelo diretório central, `[Content_Types].xml` + `xl/workbook.xml`; CSV: texto decodificável sem NUL com ≥ 2 colunas por um delimitador consistente nas 5 primeiras linhas; senão `null`)
  - `decode.ts`: `decodeText(bytes: Uint8Array, hint?: "utf-8" | "windows-1252"): string` (BOM UTF-8 → UTF-8; senão `TextDecoder("utf-8", { fatal: true })` e, se falhar, `windows-1252`; `hint` força)
  - `external-id.ts`: `deriveExternalId(prefix: string, parts: readonly string[], occurrence: number): string` = `${prefix}:` + sha256 hex de `parts` unidos por `\u001f` + `\u001f${occurrence}`, cortado para caber em 128 com o prefixo; `class OccurrenceCounter { next(key: string): number }` (0, 1, 2… por chave igual)
  - `row-errors.ts`: `ROW_ERROR_MESSAGES: Record<RowErrorCode, string>` com códigos `invalid_date`, `ambiguous_amount`, `invalid_amount`, `missing_field`, `invalid_quantity`, `unknown_kind`, `formula_without_value`, `stale_snapshot`, `too_many_positions`, `schema`; `class RowErrors { add(row: number, code: RowErrorCode, field?: string): void; list(): ImportRowError[] /* ≤ 100 */; count(): number }`

- [ ] **Step 1: Write the failing tests**: `detectFormat` com cabeçalho OFX SGML, OFX XML com BOM, zip com e sem `xl/workbook.xml` (montado em memória com `fflate.zipSync`), CSV `;` e `,`, binário com NUL → `null`; `decodeText` com `"Pão"` em UTF-8, em windows-1252 e com BOM; `deriveExternalId` estável, ocorrência diferente → id diferente, comprimento ≤ 128 com prefixo longo; `RowErrors` guarda 100 e conta 150; nenhuma mensagem de `ROW_ERROR_MESSAGES` contém `{`/interpolação.
- [ ] **Step 2: Run** `pnpm --filter @carina/api test:unit -- src/modules/imports` → FAIL.
- [ ] **Step 3: Implement** (adiciona `fflate` às dependências, versão exata).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(imports): detecção de formato, decodificação e chaves derivadas`

### Task 4: Parser OFX

**Files:**
- Create: `apps/api/src/modules/imports/parsers/ofx.ts`, `ofx.spec.ts`
- Create fixtures: `apps/api/test/fixtures/imports/ofx/{conta-sgml-1252.ofx, conta-xml-utf8.ofx, cartao-sgml.ofx, investimento.ofx, sobreposto-out.ofx, sobreposto-out-nov.ofx, sem-fitid.ofx}`

**Interfaces:**
- Consumes: Task 3 (`ParseResult`, `decodeText`, `deriveExternalId`, `RowErrors`, `PARSE_LIMITS`)
- Produces: `parseOfx(bytes: Uint8Array): ParseResult`

Regras: charset de `CHARSET:` no cabeçalho SGML (`1252` → windows-1252) ou `encoding=` do XML; SGML sem tags de fechamento normalizado por um tokenizer próprio (tag abre, valor até a próxima `<`); `STMTTRN` dentro de `BANKMSGSRSV1` ou `CREDITCARDMSGSRSV1`; `DTPOSTED` `YYYYMMDD[HHMMSS[.XXX]][[-3:BRT]]` → só a data; `TRNAMT` com `.` ou `,` decimal (OFX permite os dois; só um separador por valor, senão `ambiguous_amount`); `kind` = `credit` se `> 0`, `debit` se `< 0`; `amountBrl` = valor absoluto com 2 casas (3+ casas → `invalid_amount`); `description` = `MEMO` ou `NAME`; `institution` = `FI/ORG` ou `BANKID` ou `"OFX"`; `account` = `ACCTID`; `externalId` = `deriveExternalId("ofx", [BANKID, ACCTID, FITID], 0)`, ou, sem `FITID`, `deriveExternalId("ofx", [BANKID, ACCTID, data, valor, descrição], ocorrência)`. `INVSTMTMSGSRSV1` → `failure: "unsupported_ofx_investment"`. Sem nenhum `STMTTRN` válido → `failure: "no_valid_rows"`. Texto que não é OFX → `failure: "unreadable"`.

- [ ] **Step 1: Write the failing tests** com as fixtures: SGML 1252 dá 3 transações com descrição acentuada correta e `institution` do `ORG`; XML UTF-8 igual; cartão marca débito/crédito pelo sinal; `investimento.ofx` → `unsupported_ofx_investment`; "extrato sobreposto não duplica" (os `externalId` das transações de outubro são idênticos nos dois arquivos); sem `FITID`, duas linhas idênticas viram dois ids diferentes; `TRNAMT` `1.234,56` → `ambiguous_amount` na linha certa; 100 001 transações geradas → `failure: "limit_exceeded"`.
- [ ] **Step 2: Run** `test:unit -- ofx` → FAIL.
- [ ] **Step 3: Implement** `parseOfx`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(imports): parser OFX (SGML e XML, conta e cartão)`

### Task 5: Parser CSV e presets

**Files:**
- Create: `apps/api/src/modules/imports/parsers/csv.ts`, `csv-presets.ts`, `csv.spec.ts`
- Create fixtures: `apps/api/test/fixtures/imports/csv/{nubank-conta.csv, generico-br.csv, generico-br-1252.csv, aspas-e-quebras.csv, ambiguo.csv}`

**Interfaces:**
- Consumes: Task 1 (`CsvMapping`, `CsvPreset`), Task 3
- Produces:
  - `CSV_PRESETS: Record<CsvPreset, { mapping: CsvMapping; institution?: string }>` — `nubank_conta`: colunas `Data`, `Valor`, `Identificador`→`externalId`, `Descrição`; `dateFormat: "dd/MM/yyyy"`, `decimal: "dot"`, `delimiter: ","`, `institution: "Nubank"`. `generico_br`: colunas `Data`, `Valor`, `Descrição`, `Categoria`→`category`; `dd/MM/yyyy`, `comma`, `;`.
  - `parseCsv(bytes: Uint8Array, opts: { mapping: CsvMapping; institution: string; account: string }): ParseResult`

Regras: RFC 4180 (aspas, aspas dobradas, quebra de linha dentro de aspas) num parser próprio em streaming de caracteres; delimitador do mapeamento ou detectado na linha de cabeçalho; cabeçalho casado por nome exato após trim e NFC; coluna do mapeamento ausente no cabeçalho → `failure: "unreadable"`. Valor com `decimal: "comma"`: aceita `-1.234,56`, `1234,56`, `R$ 1.234,56`; recusa (`ambiguous_amount`) qualquer valor com `,` seguido de 3 dígitos no fim ou com os dois separadores na ordem errada; `dot` simétrico. `kind`: coluna mapeada com valores `debit|credit|débito|crédito` (case-insensitive), senão pelo sinal. `externalId`: coluna mapeada (validada por `ExternalIdSchema`; inválido → erro de linha) ou `deriveExternalId("csv", [institution, account, data, valor, descrição], ocorrência)`. Limites de Task 3.

- [ ] **Step 1: Write the failing tests**: Nubank (vírgula, ponto decimal, `Identificador` vira `externalId`, `institution` "Nubank"); genérico BR em UTF-8 e em windows-1252 dá o mesmo resultado; `1.234,56` → `"1234.56"` e `1,234.56` (em `comma`) → `ambiguous_amount` (Review Focus 2); aspas com `;` e quebra de linha; "extrato sobreposto não duplica" e "contas diferentes não colidem" (mesma linha com `account` diferente → ids diferentes); data `31/02/2026` → `invalid_date`; 65 colunas → `limit_exceeded`; linha de 70 KB → `limit_exceeded`; mapeamento apontando para coluna inexistente → `unreadable`.
- [ ] **Step 2: Run** `test:unit -- csv` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(imports): parser CSV com mapeamento explícito e presets`

### Task 6: Leitor seguro de XLSX

**Files:**
- Create: `apps/api/src/modules/imports/parsers/xlsx-reader.ts`, `xlsx-reader.spec.ts`
- Create fixtures (geradas por script de teste, commitadas): `apps/api/test/fixtures/imports/xlsx/{simples.xlsx, formula-com-cache.xlsx, formula-sem-cache.xlsx}`; hostis gerados em memória no teste (zip bomb, 51 entradas, XML com `<!DOCTYPE`)

**Interfaces:**
- Produces: `readWorkbook(bytes: Uint8Array): Workbook` com `interface Workbook { sheets: Array<{ name: string; rows: Array<Array<CellValue>> }> }`, `type CellValue = string | number | null | { formulaWithoutValue: true }`; lança `ImportLimitError` ou `XlsxUnreadableError`.

Regras: `fflate.unzipSync` com `filter` que lê `originalSize` de cada entrada e recusa antes de descompactar se a soma passar de 50 MB, se houver mais de 50 entradas ou se a razão `originalSize/size` passar de 200; só descompacta `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`, `xl/worksheets/*.xml`; qualquer XML com `<!DOCTYPE` ou `<!ENTITY` → `XlsxUnreadableError`; `fast-xml-parser` com `processEntities: false`, `allowBooleanAttributes: false`; células `t="s"` via sharedStrings, `t="inlineStr"`, `t="n"`/sem `t` → number, `t="b"` → `"TRUE"`/`"FALSE"`, `<f>` com `<v>` → valor em cache, `<f>` sem `<v>` → `{ formulaWithoutValue: true }`; datas continuam número serial (a conversão é do parser B3).

- [ ] **Step 1: Write the failing tests**: lê nomes e linhas de `simples.xlsx`; fórmula com cache devolve o valor, sem cache devolve o marcador; zip bomb (1 entrada que diz 60 MB) recusado sem descompactar; 51 entradas → `ImportLimitError`; `<!DOCTYPE` → `XlsxUnreadableError`; zip sem `xl/workbook.xml` → `XlsxUnreadableError`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (adiciona `fast-xml-parser`, versão exata).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(imports): leitor de XLSX com limites de descompactação e sem entidades`

### Task 7: Parser da Área do Investidor B3

**Files:**
- Create: `apps/api/src/modules/imports/parsers/b3.ts`, `b3.spec.ts`
- Create fixtures: `apps/api/test/fixtures/imports/xlsx/{b3-posicao.xlsx, b3-movimentacao.xlsx, b3-negociacao.xlsx, b3-tres-abas.xlsx, b3-aba-desconhecida.xlsx}` e o script `apps/api/test/fixtures/imports/xlsx/build-fixtures.ts` que as gera (rodado à mão, não no CI)

**Interfaces:**
- Consumes: Task 6 (`readWorkbook`), Task 3
- Produces: `parseB3(bytes: Uint8Array, opts: { asOf?: string }): ParseResult & { positionInstitutions: string[] }`

Layout reconstruído (abas casadas por nome sem acento e minúsculo começando com o prefixo; cabeçalho na primeira linha não vazia):
- **Posição** (`posicao`, abas `Acoes`, `BDR`, `ETF`, `Fundo de Investimento`, `Tesouro Direto`, `Renda Fixa` também aceitas pelo prefixo `posicao -` ou sozinhas): colunas `Produto`, `Instituição`, `Código de Negociação` (opcional), `Quantidade`, `Valor Atualizado`. `assetClass` pela aba (enum atual `acao | fii | tesouro | renda_fixa | fundo | caixa`): Ações, BDR e ETF → `acao`; produto de FII (nome ou código terminado em `11` na aba de fundos imobiliários) → `fii`; Fundo de Investimento → `fundo`; Tesouro Direto → `tesouro`; Renda Fixa → `renda_fixa`. O mapeamento fica documentado no topo do arquivo. `kind: "investment"`, `asOf` = `opts.asOf` (ausente com aba de Posição → `failure: "missing_as_of"`), `externalId` = `b3:pos:` + sha256 de `instituição|código ou nome NFC minúsculo` (estável entre fotografias). Mais de 1000 posições → `failure: "limit_exceeded"`.
- **Movimentação** (`movimentacao`): colunas `Entrada/Saída`, `Data`, `Movimentação`, `Produto`, `Instituição`, `Quantidade`, `Preço unitário`, `Valor da Operação`. `Dividendo` → `dividend`, `Juros Sobre Capital Próprio` → `jcp`, `Rendimento` → `dividend`; `Transferência - Liquidação` e demais → ignoradas com contagem em `stats.ignored[<tipo normalizado>]`.
- **Negociação** (`negociacao`): colunas `Data do Negócio`, `Tipo de Movimentação` (`Compra`/`Venda`), `Instituição`, `Código de Negociação`, `Quantidade`, `Preço`, `Valor`. → `buy`/`sell` com `assetCode`, `quantity`, `amountBrl` = `Valor`.
- Transações: `account` = `"B3"`, `institution` da linha, `externalId` = `deriveExternalId("b3:<aba>", [todas as colunas acima normalizadas], ocorrência)`.
- Datas: `dd/MM/yyyy` em texto ou número serial do Excel (base 1899-12-30). Valores: número da célula ou texto `R$ 1.234,56` (pt-BR, regra de `comma` da Task 5). Aba desconhecida → `stats.ignored["aba:<nome normalizado>"] += 1`. Nenhuma aba reconhecida → `failure: "unreadable"`.

- [ ] **Step 1: Write the failing tests**: cada aba sozinha e as três juntas; `positionInstitutions` lista as instituições da aba de Posição; posição sem `asOf` → `missing_as_of`; mesma posição em duas fotografias → mesmo `externalId`; negociação sobreposta em duas exportações → mesmos ids; data serial `45962` → `2025-11-01`; fórmula sem cache → `formula_without_value` na linha; aba desconhecida contada; 1001 posições → `limit_exceeded`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(imports): parser da planilha da Área do Investidor B3`

### Task 8: Gravação pelo IngestionService com cliente resolvido e substituição de posições

**Files:**
- Modify: `apps/api/src/modules/data-ingestion/ingestion.service.ts`, `ingestion.repository.ts`, `ingestion.service.spec.ts`
- Test: `apps/api/test/data-ingestion/ingestion.int.spec.ts`

**Interfaces:**
- Produces (em `IngestionService`):
  - `upsertTransactionsFor(client: ClientRef, source: Source, items: readonly NormalizedTransaction[]): Promise<IngestResult>` — o mesmo `ingest` sem `clients.resolve` (o worker já tem o cliente); `upsertTransactions` passa a delegar a ele.
  - `replaceImportedPositions(client: ClientRef, input: { institutions: readonly string[]; asOf: string; items: readonly NormalizedPosition[] }): Promise<IngestResult & { removed: number; stale: boolean }>` — numa transação: lê o maior `as_of` das posições `source='import'` dessas instituições; se for maior que `asOf` → não grava nada, não cobra, devolve `{ stale: true, upserted: 0, removed: 0 }`; senão apaga as `source='import'` dessas instituições cujo `external_id` não está em `items`, faz o upsert, cobra um `data_ingestion` e publica `data.ingested` depois do COMMIT. `items` 1..1000.
- Produces (em `IngestionRepository`): `deleteImportedPositionsExcept(tx, input: { institutions: string[]; keepExternalIds: string[] }): Promise<number>` e `latestImportedAsOf(tx, institutions: string[]): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests** (int): substituição remove o ativo vendido da mesma instituição e mantém o de outra instituição e os de `source` `api`/`synthetic`; fotografia mais antiga → `stale: true`, nada muda, nenhuma cobrança (Review Focus 4); mesma data → substitui; `upsertTransactionsFor` grava e cobra como o POST; RLS: cliente de outro tenant não é tocado.
- [ ] **Step 2: Run** `test:int -- data-ingestion` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `test:int` e `test:e2e` completos nas duas collations → PASS.
- [ ] **Step 5: Commit** `feat(ingestion): gravação com cliente resolvido e substituição de posições importadas`

### Task 9: API de importação (upload, consulta, reenvio)

**Files:**
- Create: `apps/api/src/modules/imports/imports.repository.ts`, `imports.service.ts`, `imports.service.spec.ts`, `imports.controller.ts`, `imports.module.ts`, `imports-core.module.ts`, `file-name.ts`, `file-name.spec.ts`
- Modify: `apps/api/src/app.module.ts` (importa `ImportsModule`), `apps/api/package.json` (`@types/multer` em dev), `apps/api/test/setup/redis-dbs.ts`, `apps/api/test/routes/route-scopes.e2e.spec.ts` (rotas novas e escopos)
- Test: `apps/api/test/imports/imports.e2e.spec.ts` (Redis DB 7)

**Interfaces:**
- Consumes: Task 1, Task 2, Task 3 (`detectFormat`)
- Produces:
  - `sanitizeFileName(raw: string | undefined): string` — nome-base após o último `/` ou `\`, NFC, sem `\p{C}` (inclui RTL override), sem espaços nas pontas, ≤ 120 caracteres, vazio → `"arquivo"`
  - `ImportsService.create(clientExternalId: string, file: { bytes: Buffer; originalName?: string }, fields: ImportUploadFields): Promise<{ job: ImportJobView; created: boolean }>` — `created: false` ⇒ HTTP 200
  - `ImportsService.get(clientExternalId: string, id: string): Promise<ImportJobView>` (404 se não existir no tenant/cliente) e `list(clientExternalId: string, opts: { limit?: number; after?: string }): Promise<ImportJobList>` (mais recentes primeiro, keyset por `(created_at, id)`)
  - `ImportsRepository` (só SQL/Prisma sob `TenantPrismaService`): `findBySha`, `insertQueued(tx, …)`, `requeue(tx, id, options)`, `insertFile(tx, jobId, bytes)`, `countActive(clientId)`, `get`, `list`, mais os métodos do worker na Task 10
  - Rotas: `POST /api/clients/:clientId/imports` (`@RequireScopes("data:write")`, `FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10, fieldSize: 16 * 1024 } })`, memória), `GET /api/clients/:clientId/imports` e `GET /api/clients/:clientId/imports/:id` (`@RequireScopes("chat")`)

Fluxo do `create`: arquivo ausente ou vazio → 422; acima do limite → 413 (problem+json; mapear o `LIMIT_FILE_SIZE` do multer); `detectFormat`; `format` informado e diferente do detectado → 422; monta e valida `ImportOptions` (CSV: preset preenche `institution` se o campo vier vazio; `account` obrigatório); sha256 dos bytes; `clients.resolve(…, { create: true })`; numa transação com o cliente fixado: existente `queued|parsing|done` → devolve sem mudar nada; existente `failed` → `requeue` (status `queued`, `failure_code` null, `stats`/`errors` zerados, `options` novas, `progress_at` now) + `insertFile`; inexistente → se `countActive ≥ 5` → 429 (`RateLimitedError`, `Retry-After: 30`); senão `insertQueued` + `insertFile` + auditoria `import.created` (`channel: "import"`, `query: "import.created"`, `agents: []`, sem nome de arquivo); depois do COMMIT publica `import.requested` em `jobs`. Se a publicação falhar: log de erro e a resposta continua 202; o job fica `queued`, a limpeza da Task 10 o marca `expired` em 1 h e o reenvio do mesmo arquivo o reenfileira (comportamento documentado na Task 13).

- [ ] **Step 1: Write the failing tests**: unidade de `sanitizeFileName` (Review Focus 5: `../../etc/passwd` → `passwd`, `a‮b.csv` → `ab.csv`, 10 KB → 120); e2e: OFX válido → 202 com `status: "queued"`, `import_file` gravado; mesmo arquivo de novo → 200 com o mesmo `id`, nenhuma cobrança nova; job marcado `failed` à mão + reenvio → 202 com o mesmo `id`, `queued`, bytes regravados; 10 MB + 1 → 413; PNG → 422; `format=csv` com OFX → 422; CSV sem `account` → 422; sexto job ativo → 429 com `Retry-After`; chave sem `data:write` → 403; GET com chave `chat` → 200 com `ImportJobViewSchema` válido; GET de job de outro tenant → 404; lista paginada.
- [ ] **Step 2: Run** `test:e2e -- imports` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `test:e2e` e `test:int` completos nas duas collations → PASS.
- [ ] **Step 5: Commit** `feat(imports): upload, consulta e reenvio de importações`

### Task 10: Worker de importação e limpeza

**Files:**
- Create: `apps/api/src/modules/imports/import.worker.ts`, `import.worker.spec.ts`, `import-cleanup.job.ts`, `import-cleanup.job.spec.ts`, `parse-file.ts` (despacha por formato com o tempo limite)
- Modify: `apps/api/src/modules/imports/imports-core.module.ts`, `imports.repository.ts`, `apps/api/src/worker.module.ts`
- Test: `apps/api/test/imports/imports.int.spec.ts` (Redis DB 15)

**Interfaces:**
- Consumes: Tasks 3–9 (`parseOfx`, `parseCsv`, `CSV_PRESETS`, `parseB3`, `upsertTransactionsFor`, `replaceImportedPositions`, `ImportsRepository`)
- Produces:
  - `parseFile(format: ImportFormat, bytes: Uint8Array, options: ImportOptions, signal: AbortSignal): Promise<ParseResult>` — roda o parser; estouro de 30 s → `failure: "limit_exceeded"`. Se o teste de tempo do arquivo de 10 MB mostrar o event loop do worker bloqueado por mais de 1 s, o parse vai para `worker_threads` aqui (decisão registrada no relatório).
  - `ImportWorker` (padrão do `SyncWorker`: `onApplicationBootstrap` com `WORKERS_ENABLED !== "false"`, grupo `imports` no stream `jobs`, só `import.requested`, demais ACK sem efeito, logger por token `IMPORT_LOGGER`)
  - `ImportsRepository`: `claim(jobId): Promise<{ job; bytes } | null>` (`UPDATE … SET status='parsing', progress_at=now() WHERE id=$1 AND status='queued' RETURNING …` + leitura dos bytes; `null` = já tomado → ACK), `touchProgress(jobId)`, `finish(tx, jobId, { status, failureCode, stats, errors })` (também `DELETE FROM import_file WHERE import_job_id=$1`), `expireFiles(olderThan: Date)`, `failStuck(olderThan: Date)`
  - `ImportCleanupJob` (padrão do `ReconciliationJob`: `setInterval` unref de 5 min, lock global `imports:cleanup`): `import_file` com `created_at` < now − 1 h → apaga e o job vira `failed`/`expired`; `parsing` com `progress_at` < now − 15 min → `failed`/`stuck` e apaga o `import_file`.

Fluxo do worker: `TenantContext.run(tenantId)` + `withClient`; `claim`; `import.progress { stage: "parsing", processed: 0, total: 0 }`; `parseFile`; `failure` → `finish(failed, failure)`; B3 com posições → `replaceImportedPositions` (`stale` → todas as posições viram `stale_snapshot` nos erros); transações em lotes de 1000 por `upsertTransactionsFor`, `touchProgress` e `import.progress { stage: "writing", processed, total }` após cada lote; nada gravado e nada válido → `failed`/`no_valid_rows`; senão `done`; `finish` na transação; `import.finished` em `inbox.events` depois do COMMIT; auditoria `import.finished` (`query: "import.finished:<status>"`). Erro inesperado → `finish(failed, "internal")` em melhor esforço e ACK (não reentrega: os bytes já podem ter saído; o usuário reenvia). Eventos de progresso e término vão para `inbox.events` (são para a web), `import.requested` vem de `jobs`.

- [ ] **Step 1: Write the failing tests**: int — OFX fim a fim: `done`, transações gravadas com `source: "import"`, `import_file` vazio, cobrança de 1 lote, `data.ingested` publicado; 2 500 transações de CSV → 3 lotes, 3 cobranças, eventos `writing` 1000/2000/2500; reentrega do mesmo `import.requested` não processa de novo (claim); B3 posição substitui; arquivo ilegível → `failed`/`unreadable` sem bytes; "reenvio após stuck" (Review Focus 3): job `parsing` com `progress_at` antigo → limpeza marca `stuck` → reenvio pela API (Task 9) → `done` sem duplicar linhas; `import_file` de 2 h → `expired`; nenhum log, erro ou evento contém a descrição de uma transação da fixture (procurar o texto no logger fake e nos eventos). Unidade: parser que dorme 31 s com relógio fake → `limit_exceeded`.
- [ ] **Step 2: Run** `test:int -- imports` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `test:int` e `test:e2e` completos nas duas collations → PASS.
- [ ] **Step 5: Commit** `feat(imports): worker de importação e limpeza de arquivos temporários`

### Task 11: Progresso no WebSocket

**Files:**
- Modify: `apps/api/src/modules/chat/inbox-broadcast.ts` (e spec), `apps/api/test/chat/ws.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`import.progress`, `import.finished`, `import_progress`, `import_finished`), Task 10 (publica em `inbox.events`)
- Produces: `InboxBroadcast.dispatch` também trata `import.progress` → `ChatEvent` `import_progress` e `import.finished` → `import_finished`, enviados só aos inscritos da chave `(tenantId, clientId)` do evento, sem leitura de banco, mantendo a ordem por chave já existente.

- [ ] **Step 1: Write the failing tests**: unidade — evento de import do tenant A/cliente X chega só ao inscrito A/X (não a A/Y nem B/X), na ordem progress→finished; e2e — socket aberto, upload pela API com o worker no mesmo processo de teste, o socket recebe `import_progress` e `import_finished { status: "done" }`; socket de outro tenant não recebe nada.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** suítes completas → PASS.
- [ ] **Step 5: Commit** `feat(chat): progresso da importação no WebSocket`

### Task 12: Painel "Importar arquivo" na web

**Files:**
- Create: `apps/web/src/features/imports/ImportPanel.tsx`, `ImportPanel.module.css`, `ImportPanel.test.tsx`
- Modify: `apps/web/src/api/client.ts` (upload multipart e GETs), `apps/web/src/api/schemas.ts` (reexporta os schemas de `@carina/shared`), `apps/web/src/App.tsx` (painel ao lado da carteira), o handler de `ChatEvent` da web (recarrega a carteira e a lista em `import_finished`)

**Interfaces:**
- Consumes: Task 1 (schemas), Task 9 (rotas), Task 11 (eventos)
- Produces: `uploadImport(clientId: string, file: File, fields: ImportUploadFields): Promise<ImportJobView>` e `listImports(clientId: string): Promise<ImportJobList>` em `client.ts`

Tela (spec §5.8): escolher arquivo; formato `automático | OFX | CSV | B3`; com CSV, preset (`nubank_conta`, `generico_br`), `institution` (preenchida pelo preset) e `account` (sugestão "conta"); com B3, data da posição (padrão hoje); lista dos últimos 10 jobs com nome, status em português (`na fila`, `processando N%`, `concluído`, `falhou: <mensagem do failureCode>`), contagens e até 10 erros por linha (linha + mensagem); `import_progress` atualiza a porcentagem; `import_finished` recarrega lista e carteira. Erros da API (413/422/429) mostrados com o `detail` do problem+json.

- [ ] **Step 1: Write the failing tests** (Vitest + Testing Library, `fetch` e socket fakes): o formulário só mostra os campos de CSV com CSV escolhido; enviar chama `uploadImport` com os campos certos; 413 mostra a mensagem; `import_progress` 500/1000 mostra `processando 50%`; `import_finished` recarrega a lista; status `failed` com `expired` mostra a mensagem em português.
- [ ] **Step 2: Run** `pnpm --filter @carina/web test` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** testes, lint, typecheck e build da web → PASS.
- [ ] **Step 5: Commit** `feat(web): painel de importação de arquivos`

### Task 13: Documentação

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/DECISOES-E-GARANTIAS.md`, `.env.example` (se alguma variável nova surgir; nenhuma é prevista)

- [ ] **Step 1:** README: seção curta "Importação de arquivos" com um `curl -F file=@… -F format=… ` de exemplo (e o de CSV com `csvPreset`, `institution`, `account`), as limitações (formatos reconstruídos da documentação pública, sem arquivo real; PDF SINACOR na entrega 2; `INVSTMTRS` não suportado; reenvio de job falho reprocessa) e a linha nas garantias com os testes que as provam.
- [ ] **Step 2:** ARCHITECTURE: fluxo da §5.1 do spec, tabela `import_file`, grupos `imports` em `jobs`, eventos em `inbox.events`, limpeza.
- [ ] **Step 3:** DECISOES-E-GARANTIAS: as decisões da §7 do spec com o motivo; garantias (bytes apagados, RLS em `import_file`, sem conteúdo em log/erro, idempotência por `externalId`, substituição de posições) com arquivo e título do teste.
- [ ] **Step 4:** Conferir links e âncoras dos três arquivos (0 quebrados).
- [ ] **Step 5: Commit** `docs(imports): importação de arquivos no README, arquitetura e garantias`
