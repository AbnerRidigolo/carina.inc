# Importação de arquivos (fase 2, entrega 1): OFX, CSV e XLSX da B3

Status: rascunho para aprovação · 2026-11-16

## 1. Intenção

O CARINA é um projeto de portfólio para mostrar no trabalho (TS/Node). A fase 1 já recebe posições e
transações do cliente final pela API de ingestão e pelo gerador sintético. Esta entrega acrescenta a
terceira fonte prevista no spec da migração (§6.4): o tenant B2B, ou o próprio investidor pela web,
sobe um arquivo que ele já tem e os dados entram na carteira **sem custo de agregador**. O que tem que
convencer quem lê o código: parsers robustos contra arquivo real e hostil, processamento assíncrono
isolado por tenant, idempotência e LGPD (o arquivo não fica guardado).

A importação foi dividida em duas entregas (decisão do usuário): **esta** cobre o núcleo (job
assíncrono, hash, erros por linha, progresso) com OFX, CSV e XLSX da Área do Investidor B3; a
**seguinte**, com spec próprio, cobre o PDF de nota de corretagem SINACOR e o eventual uso de LLM.

## 2. Objetivos, não objetivos e anti-objetivos

**Objetivos**
- `POST /api/clients/:clientId/imports` (multipart, até 10 MB) cria um `import_job` e responde 202; o
  worker faz o parse e grava pelo mesmo caminho da API de ingestão (upsert, cobrança, `data.ingested`).
- Formatos: OFX (extrato bancário, SGML 1.x e XML 2.x), CSV (mapeamento de colunas, com presets) e
  XLSX da Área do Investidor B3 (abas de posição, movimentação e negociação).
- O mesmo arquivo (mesmo SHA-256, mesmo cliente) nunca é processado duas vezes; reimportar não duplica
  linhas.
- Erros por linha ficam em `import_job.errors` sem derrubar o arquivo inteiro.
- Progresso e término chegam à web pelo WebSocket já existente; a web ganha uma tela de importação.

**Não objetivos (desta entrega)**
- PDF de nota de corretagem e qualquer uso de LLM na importação (entrega 2).
- Extrato de investimentos em OFX (`INVSTMTRS`): corretoras brasileiras quase não exportam; o parser
  recusa com erro claro.
- Outros presets de CSV além dos listados em §5.4; edição de mapeamento salvo por tenant.
- Reprocessar um job falho com outro mapeamento (o usuário sobe de novo; ver §5.2 sobre o hash).

**Anti-objetivos (seria falha mesmo funcionando)**
- O arquivo original (ou o conteúdo de uma linha) persistir depois do parse, em banco, log ou erro.
- Um tenant ler, processar ou receber progresso do arquivo de outro.
- Gravar número errado em silêncio: separador decimal ou data ambíguos falham a linha (ou o arquivo),
  nunca "chutam".
- Reimportar o mesmo extrato (ou um extrato sobreposto) duplicar transações.
- Um arquivo hostil (zip bomb, XML gigante, CSV com milhões de colunas) derrubar ou travar o worker.

## 3. Restrições

- Mesma pilha e regras da fase 1: NestJS 12 ESM, Prisma 7 com RLS (`TenantPrismaService`), Zod 4 nos
  contratos de `packages/shared`, Redis Streams (`jobs`), Vitest unit/int/e2e com as duas collations,
  cobertura ≥ 80%.
- Sem arquivos reais: os quatro formatos são **reconstruídos a partir da documentação pública**
  (especificação OFX 1.0.2/2.x, layout conhecido do CSV da Nubank, planilhas da Área do Investidor
  B3). As fixtures são sintéticas e anonimizadas; isso vai para as limitações do README.
- Dependências novas só onde não há alternativa razoável, mantidas, sem avaliação de fórmulas e sem
  executar nada do arquivo.

## 4. Abordagens consideradas

1. **Parse assíncrono no worker, com o arquivo temporário no Postgres (escolhida pelo usuário).** A
   API grava o job e os bytes numa tabela temporária sob RLS e publica em `jobs`; o worker faz o
   parse, grava, apaga os bytes e manda o progresso. Sobrevive a reinício, o isolamento vem do banco e
   a API não trava com planilha pesada. Custo: os bytes ficam no banco por segundos, e uma limpeza
   periódica apaga os que sobrarem.
2. **O mesmo fluxo com os bytes no Redis (TTL).** Mais leve para o Postgres, mas sem RLS (isolamento
   só pela chave) e perde o job se o Redis cair entre o upload e o parse.
3. **Parse síncrono na requisição.** O mais simples e o melhor para a LGPD (o arquivo nunca sai da
   memória da requisição), mas prende a API numa planilha de 10 MB, tira o sentido do progresso e
   diverge do spec.

## 5. Design

### 5.1 Fluxo

```
web/tenant ── POST /imports (multipart) ──► api
   api: limite 10 MB → detecta/valida formato → SHA-256 → INSERT import_job (queued)
        + INSERT import_file (bytes)  [mesma transação, RLS]
        → XADD jobs import.requested  → 202 {job}
worker: consome import.requested → UPDATE status queued→parsing (claim atômico)
        → lê bytes → parser → itens normalizados + erros por linha
        → IngestionService em lotes de 1000 (source "import") → stats/errors
        → status done|failed + DELETE import_file  [mesma transação]
        → publica import.progress / import.finished → WebSocket do tenant+cliente
```

### 5.2 API

- `POST /api/clients/:clientId/imports` (escopo `data:write`; `:clientId` é o `externalId`, como na
  ingestão; o cliente é criado se não existir, como no POST de posições). Campos multipart: `file`
  (obrigatório), `format` (`ofx` | `csv` | `b3_xlsx`; se ausente, detectado pelo conteúdo, §5.3);
  para CSV, `csvPreset` (nome do preset) **ou** `csvMapping` (JSON validado por Zod, §5.4), mais
  `institution` e `account` (texto curto; o preset pode preencher `institution`, `account` é sempre
  informado; a web sugere "conta"); para XLSX da B3 com aba de Posição, `asOf` (`YYYY-MM-DD`, data da
  fotografia; obrigatório porque a planilha não traz uma data confiável nas células e o nome do arquivo
  não é dado; a web sugere a data de hoje). Os campos extras são validados por um schema Zod em
  `packages/shared` e guardados no job (`import_job.options`, JSONB) para o worker.
- Recusas síncronas (problem+json, nada gravado, nada cobrado): arquivo vazio ou maior que 10 MB (413),
  formato não reconhecido ou incoerente com `format` (422), CSV sem mapeamento (422), mais de 5 jobs
  `queued`/`parsing` do mesmo cliente (429).
- Mesmo SHA-256 para o mesmo cliente (a unicidade já existe em
  `import_job (tenant_id, client_id, file_sha256)`):
  - job `queued`, `parsing` ou `done` → **200** com o job existente, sem criar outro e sem cobrar;
  - job `failed` (qualquer motivo: mapeamento errado, `expired`, `stuck`, erro inesperado) → o MESMO
    job é **reenfileirado** (202): opções novas do upload, `errors`/`stats` zerados, bytes gravados de
    novo em `import_file`, status `queued`, novo `import.requested`. É seguro porque a gravação é por
    upsert idempotente; assim uma queda do worker ou um mapeamento errado nunca deixam o arquivo
    impossível de importar.
- `GET /api/clients/:clientId/imports` (lista paginada, mais recentes primeiro) e
  `GET /api/clients/:clientId/imports/:id` (escopo `chat`, como os GET de posições, para a web ler).
  Resposta: `id`, `format`, `fileName`, `status`, `stats` (linhas lidas, posições e transações
  gravadas, linhas com erro), `errors` (até 100), `createdAt`, `updatedAt`.
- `fileName`: só o nome-base, sem caminho, normalizado (NFC), sem caracteres de controle, truncado em
  120; serve só para exibição.

### 5.3 Detecção de formato

Pelo conteúdo, nunca pela extensão: OFX pelo cabeçalho `OFXHEADER:` (SGML) ou `<?OFX` / `<OFX>` (XML);
XLSX pela assinatura ZIP com `[Content_Types].xml` e `xl/workbook.xml`; CSV como último caso (texto
decodificável e com delimitador consistente). Se `format` vier informado e não bater com o conteúdo,
422.

### 5.4 Parsers

Funções puras `bytes → { positions, transactions, errors, stats }`, sem I/O, cada item validado pelos
schemas `NormalizedPosition`/`NormalizedTransaction` antes de sair. Um erro de linha registra
`{ row, field?, code, message }` com mensagem fixa por código: **nunca** o conteúdo da linha (LGPD).

- **OFX** (bancário, `BANKMSGSRSV1`/`STMTTRNRS` e cartão, `CREDITCARDMSGSRSV1`): parser próprio
  tolerante a SGML sem tags de fechamento; charset pelo cabeçalho (`CHARSET:1252` comum no Brasil →
  windows-1252; XML → declarado ou UTF-8). Cada `STMTTRN` vira transação `debit`/`credit` pelo sinal de
  `TRNAMT`; `institution` de `FI/ORG` (ou `BANKID`), `account` de `ACCTID` (os campos do upload são
  ignorados no OFX). `externalId` derivado de
  `ofx:<BANKID>:<ACCTID>:<FITID>` (hash se passar de 128). `LEDGERBAL` não vira posição (fora do
  escopo). `INVSTMTRS` → arquivo recusado (`unsupported_ofx_investment`).
- **CSV**: decodificação UTF-8 (com ou sem BOM) e, se inválida, windows-1252; delimitador `;` ou `,`
  detectado pelo cabeçalho; aspas RFC 4180. Mapeamento `{ date, amount, description, kind?, category?,
  externalId?, dateFormat, decimal }` (`institution` e `account` vêm dos campos do upload, §5.2), onde `dateFormat` é `dd/MM/yyyy` ou `yyyy-MM-dd` e `decimal` é
  `comma` ou `dot`, **obrigatórios** (sem adivinhar). Presets: `nubank_conta` (`Data,Valor,
  Identificador,Descrição`) e `generico_br` (`;`, vírgula decimal, `dd/MM/yyyy`). `externalId`: a coluna
  mapeada ou `csv:<hash(instituição|conta|data|valor|descrição|n-ésima ocorrência igual no arquivo)>`,
  para que duas linhas idênticas legítimas não se fundam, contas diferentes não colidam e reimportar o
  mesmo conteúdo (ou um extrato sobreposto) não duplique.
- **XLSX B3**: abas reconhecidas pelo nome e pelos cabeçalhos (layout reconstruído): **Posição**
  (ações, FIIs, BDRs, ETFs, Tesouro Direto, renda fixa → `NormalizedPosition`, `institution` =
  instituição da linha), **Movimentação** (proventos: dividendo, JCP, rendimento; transferências de
  liquidação são ignoradas com contagem em `stats`) e **Negociação** (compra/venda → `buy`/`sell` com
  quantidade e valor). Abas desconhecidas são ignoradas e listadas em `stats`. Só valores de célula;
  fórmulas nunca são avaliadas (usa o valor em cache, ou erro de linha se não houver).
  `externalId`: posição `b3:pos:<instituição>:<código do ativo ou nome normalizado>` (estável entre
  fotografias, para o upsert atualizar); Negociação e Movimentação
  `b3:<aba>:<hash(todas as colunas mapeadas da linha, normalizadas)|n-ésima ocorrência igual>`, o mesmo
  esquema do CSV, para exportações sobrepostas não duplicarem. `asOf` de toda posição = o `asOf` do
  upload.

### 5.5 Semântica de posição (decisão minha)

Uma planilha de posição é uma fotografia numa data. Se só fizéssemos upsert, um ativo vendido entre
duas fotografias ficaria na carteira para sempre, inflando o patrimônio. Por isso, ao importar uma aba
de Posição, **as posições `source = "import"` das instituições presentes no arquivo são substituídas
na mesma transação** (remove as que não aparecem, upsert das que aparecem), desde que a nova
fotografia (o `asOf` informado no upload) não seja mais antiga que a gravada (se for, as linhas entram como erro `stale_snapshot` e
nada é substituído). Posições de outras fontes (`api`, `synthetic`) nunca são tocadas. Limite: até
1000 posições por arquivo (uma transação).

### 5.6 Worker e armazenamento temporário

- Nova tabela `import_file (tenant_id, client_id, import_job_id, bytes bytea, created_at)` com RLS por
  tenant e cliente (mesmas políticas de `import_job`), FK com cascata. Fica separada para manter
  `import_job` leve e para "não sobrou byte" ser verificável com uma consulta.
- Novo evento `import.requested { importJobId }` em `StreamEventSchema`, consumido no `jobs` pelo
  worker. Claim atômico (`UPDATE … SET status='parsing' WHERE id=$1 AND status='queued'`): reentrega
  do stream não processa duas vezes.
- Transações gravadas em lotes de 1000 pelo `IngestionService` (cada lote cobrado como
  `data_ingestion`, R$ 0,05, igual à API; lote gravado ⇔ lote cobrado). O `data.ingested` de cada lote
  já aciona o Sync; nada novo no Sync.
- Término: `done` (com ou sem erros de linha, desde que algo válido tenha sido gravado) ou `failed`
  (arquivo ilegível, zero itens válidos, limite estourado, erro inesperado). A troca de status e o
  `DELETE` de `import_file` acontecem na mesma transação. Um job que falha depois de gravar alguns lotes
  fica `failed` com `stats` dizendo o que foi gravado (os lotes gravados continuam: o upsert é
  idempotente e o usuário pode subir o arquivo corrigido).
- Limpeza periódica (no worker, com lock como a reconciliação): `import_file` com mais de 1 hora →
  apaga e marca o job `failed` (`expired`); job `parsing` sem progresso há mais de 15 minutos →
  `failed` (`stuck`).
- Auditoria: `import.created` e `import.finished` em `audit_event` (sem nome de arquivo nem conteúdo).

### 5.7 Defesa contra arquivo hostil

Limite de 10 MB no upload (multer em memória, recusa ao passar do limite). XLSX: antes de abrir,
soma dos tamanhos descompactados ≤ 50 MB, ≤ 50 entradas, razão de compressão por entrada limitada;
recusa XML com DTD/entidades. OFX/CSV: ≤ 100 000 linhas e ≤ 64 colunas, linha ≤ 64 KB. Tempo máximo
de parse por arquivo (30 s) com o parse fora do event loop principal do worker se o tempo medido
justificar (decisão do builder, com o teste de tempo como guarda). Todo limite estourado vira `failed`
com código fixo.

### 5.8 Progresso na web

- Novos eventos de stream `import.progress { importJobId, stage, processed, total }` e
  `import.finished { importJobId, status }`, entregues só aos sockets do mesmo tenant e cliente,
  pelo mesmo mecanismo de difusão do `InboxBroadcast` (um `tail` por processo).
- Novos `ChatEvent`: `import_progress` e `import_finished`.
- Web: painel "Importar arquivo" junto da carteira: escolher arquivo, formato (ou automático) e, para
  CSV, preset; lista dos últimos jobs com status, contagens e os erros por linha; ao `import_finished`
  com `done`, a carteira recarrega. A chave da demo precisa de `data:write` (o seed passa a dar).

```
┌ Importar arquivo ─────────────────────────────┐
│ [ Escolher arquivo ]  extrato-out.ofx         │
│ Formato: (•) automático ( ) OFX ( ) CSV ( ) B3│
│ Preset CSV: [ nubank_conta ▾ ]   [ Importar ] │
├───────────────────────────────────────────────┤
│ extrato-out.ofx   concluído  212 transações   │
│ posicao-b3.xlsx   processando 40%             │
│ gastos.csv        falhou: mapeamento inválido │
└───────────────────────────────────────────────┘
```

## 6. Testes

- Fixtures sintéticas por formato em `apps/api/test/fixtures/imports/` (OFX SGML 1252, OFX XML UTF-8,
  cartão, CSV Nubank, CSV genérico com vírgula decimal, XLSX B3 com as três abas), mais versões
  hostis (zip bomb, XML com entidade, CSV gigante, datas e decimais ambíguos).
- Unidade: cada parser (casos felizes, erro por linha, limites, encoding); detecção de formato;
  substituição de posições (§5.5).
- Integração: claim atômico com reentrega; bytes apagados ao terminar e na limpeza; RLS de
  `import_file`; mesmo hash → mesmo job; cobrança por lote.
- E2E: upload → job → `done` → posições e transações visíveis; 413/422/429; outro tenant não vê o job
  nem recebe o progresso; WebSocket recebe `import_progress`/`import_finished`.
- Web: painel de importação (Vitest + Testing Library).

## 7. Decisões tomadas por mim (corrigíveis)

- Mesmo arquivo → 200 com o job existente (não 409); se o job existente falhou, ele é reenfileirado.
- CSV recebe `institution` e `account` no upload e eles entram no `externalId` derivado.
- Data da fotografia da B3 informada no upload (`asOf`), não lida das células nem do nome.
- Chaves da B3: posição estável por instituição e ativo; negociação e movimentação por hash da linha
  com contagem de ocorrências.
- Escopo `chat` para ler os jobs; `data:write` para enviar; o seed dá `data:write` à chave da demo.
- Substituição de posições por instituição (§5.5) em vez de só upsert.
- Presets de CSV: `nubank_conta` e `generico_br`.
- Tabela `import_file` separada; limpeza a 1 h; job preso a 15 min.
- Limites: 10 MB, 5 jobs ativos por cliente, 50 MB descompactado, 100 000 linhas, 64 colunas, 30 s.

## 8. Deixado ao builder

Biblioteca de leitura de XLSX (mantida, sem avaliar fórmulas, que permita checar os tamanhos antes de
descompactar ou leitura própria com uma lib de zip); parser de multipart (o padrão do Nest/express);
estrutura interna dos parsers; se o parse roda em `worker_threads`; nomes exatos de códigos de erro.
