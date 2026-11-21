# Decisões, garantias e limitações — CARINA (fase 1)

Este documento reúne o material de referência que o [README](../README.md) resume: as decisões de
arquitetura, os defeitos do Python que foram corrigidos, cada garantia com o teste que a prova, os
pontos de segurança e as limitações conhecidas. A descrição dos processos e dos componentes está em
[ARCHITECTURE.md](ARCHITECTURE.md).

## Decisões de arquitetura

| Tema | Decisão | Alternativas descartadas (motivo) |
| --- | --- | --- |
| Organização | Monorepo **pnpm workspaces** | Nx (configuração demais para o tamanho); repositórios separados (tipos duplicados) |
| Backend | **NestJS 12** (ESM, Node 22.22.2 fixado em `.nvmrc`) | Express/Fastify puros (organização toda manual) |
| Frontend | **React + Vite** | Next.js (peças demais ao lado do NestJS); Angular |
| Dados transacionais | **PostgreSQL 17 + Prisma 7** (driver adapter `pg`) | Tudo no FalkorDB (não serve para dado transacional) |
| Conhecimento | **pgvector no mesmo Postgres**, grafo em tabelas, isolamento por **RLS** | Neo4j Community (sem controle de acesso por papel); FalkorDB (SSPL, ecossistema JS fraco) |
| Agentes | **LangGraph.js** com `interrupt()` e checkpointer Postgres | Vercel AI SDK (sem pausa durável pronta); Mastra (licença `ee/`) |
| Modelos | **LangChain.js** com `withFallbacks()` por papel; embeddings NVIDIA | LiteLLM (só Python); misturar LangChain com AI SDK |
| Cache, limites, eventos | **Redis**: TTL, sorted set + Lua (limites e cota atômicos), **Streams** com consumer groups e DLQ | Limites em memória (não valem com várias instâncias) |
| Dados de clientes | **Custo zero**: API de ingestão, gerador sintético e (fase 2) importação de arquivos, atrás de `FinancialDataProvider` | Pluggy/Belvo (a partir de R$ 1.500–2.500/mês); APIs da B3 (contrato); Open Finance direto (autorização do BC) |
| Agentes restantes | Quatro especialistas no mesmo grafo e no mesmo caminho dos três atuais (prompt, schema Zod + `refine`, fallback, mock, cartão na web): strategist, tax, researcher e assessor_liaison | Tool calling para researcher e assessor gravarem na base (escrita disparada por modelo a partir de conteúdo não confiável envenena a base); categorizer como agente no chat (é transformação de dado, não conversa) |
| Custo por turno | **No máximo 3 especialistas por turno**, na ordem fixa insight, risk, predictor, strategist, tax, researcher, assessor_liaison, na heurística e no `normalizePlan` | Deixar o classificador chamar todos (a pergunta comum passaria a acionar muito mais modelos) |
| Pesquisa e assessor | Researcher **só sobre a base de conhecimento**, com fontes; assessor_liaison **só redige** (`AssessorBrief`), nada é enviado | Busca web (não há ferramenta, nem havia no Python); envio por WhatsApp ou e-mail (canais são da fase 3) |
| Cobrança do `tax` | Turno com `tax` no plano é cobrado como `optimization` (R$ 30,00), como no Python (fase 2 exige os mesmos tipos de trabalho); os demais turnos seguem pelo número de agentes, sem mudança | Cobrar o `tax` por número de agentes (R$ 7,50): divergiria do Python |
| Categorizer | **Regras determinísticas** na gravação das transações, nos dois caminhos de upsert; `kind` primeiro, depois as regras; sem regra, `null`; categoria enviada nunca é sobrescrita | LLM no ambíguo (custo por transação e resultado não repetível); "outros" inventado (o Sync já mostra "sem categoria") |
| Testes | **Vitest**, Supertest, Testing Library + MSW; Postgres/Redis reais | Jest (problemas com pacotes só-ESM do NestJS 12) |
| Qualidade | TypeScript `strict` + `noUncheckedIndexedAccess`, ESLint + Prettier, versões exatas no lockfile | — |

### Onde a implementação se afastou do plano

O que foi construído difere do plano em alguns pontos. Cada mudança tem um motivo registrado:

- **Pluggy fora; `data-ingestion` no lugar.** O spec foi revisado antes da implementação por
  causa do custo. Os dados de clientes entram pela API de ingestão (lotes de até 1.000 itens,
  upsert idempotente, `data:write`) ou pelo gerador sintético. O Sync, sem LLM, os transforma em
  documentos, entidades e relações da base de conhecimento.
- **Grafo com nós `retrieve`, `respond` e `approval`.** O nó `answer` virou `respond` porque o
  LangGraph proíbe nó com o nome de um canal do estado. O executor e a aprovação ficaram em
  **dois nós**: na retomada o LangGraph reexecuta o nó do `interrupt()` desde o início, e assim a
  proposta (chamada de modelo) não roda de novo.
- **O banco decide a retomada, não o evento.** O valor do `resume` é só um sinal. O nó `approval`
  relê a `approval_request` sob RLS e só chama `executeOnce` se ela estiver `approved`.
- **Processo de workers separado.** `main.worker.ts` roda Sync, ResumeWorker e reconciliação. No
  compose a API sobe com `WORKERS_ENABLED=false`. Em desenvolvimento, `main.ts` sozinho também
  roda tudo.
- **Revalidação da chave em sockets abertos.** Um ticket vale 30 s e uma vez só (`GETDEL`).
  Antes de cada turno, o `LiveKeyService` revalida chave, escopo e tenant por id (cache de no
  máximo `API_KEY_REVALIDATE_TTL_MS`, 60 s por padrão), e a conexão tem vida máxima
  (`WS_MAX_CONNECTION_MS`). Para isso a migração 0006 criou `tenant.suspended_at` e
  `resolve_api_key_by_id`.
- **Reconciliação sem credencial de dono.** A reconciliação lista os tenants por uma função
  `SECURITY DEFINER` (`active_tenant_ids`) e processa cada um sob RLS como `carina_app`. A API e o
  worker nunca recebem a senha do `carina_migrator`.
- **Agendamento.** Em vez de `@nestjs/schedule`, um `setInterval` com lock Redis por tick
  (`ReconciliationJob`).
- **Frontend sem TanStack Query.** O estado fica no React e num barramento de eventos interno; o
  WebSocket reconecta com backoff.
- **Versão fixada por compatibilidade.** `@langchain/langgraph-sdk` está em 1.12.9 (override em
  [`pnpm-workspace.yaml`](../pnpm-workspace.yaml)), porque o 1.12.10 exige `@langchain/core` ≥ 1.3.2.
- **Node 22.22.2.** O jsdom 31 exige `^22.22.2`. O `.nvmrc` é a única fonte, e o CI, as imagens
  Docker e o `engines` seguem essa versão
  ([`toolchain.spec.ts`](../apps/api/src/toolchain.spec.ts)).

### Agentes restantes e categorizer (fase 2, entrega 1)

Desenho completo no [spec](superpowers/specs/2026-11-19-agentes-restantes-design.md). O que a
implementação mudou em relação a ele:

- **"ir" não é palavra-chave.** O spec listava `ir ` como termo do `tax`. O "ir" solto foi
  descartado porque também é o verbo ("vou ir ao banco"). Acionam o `tax`: `irpf`, `imposto de
  renda` (via `impostos?`) e `declaração de IR`. Um "IR" sozinho não aciona. Termos curtos ou
  ambíguos (`meta`, `imposto`, `fonte`, `assessor`, `darf`) casam só como palavra inteira.
- **Categorizer: `kind` primeiro.** `buy`, `sell`, `dividend` e `jcp` → `investimento`; `tax` →
  `impostos`; `fee` → `tarifas`; depois a regra de `impostos` (imposto, darf, iof); depois as
  regras do Python. "mercado" solto foi retirado das regras (casava Mercado Livre, Mercado Pago e
  "mercado financeiro" como alimentação).
- **Cartão do assessor.** Mostra todo o `sharedData`, não só o que casa com cada pergunta: sobras
  vão em "Outros dados compartilhados" e a pergunta sem entrada correspondente é sinalizada.

### Limitações dos agentes restantes e do categorizer

- **Researcher sem web.** Responde só com a base de conhecimento do cliente (nem o Python tinha
  busca web). Não grava na base; o `ingest_findings` do Python não foi portado.
- **Assessor_liaison só redige.** Nada é enviado ao assessor; o `ingest_assessor_knowledge` do
  Python não foi portado. Os canais (WhatsApp, e-mail) são da fase 3.
- **Categorizer só por regras, sem parcelas e sem LLM.** Descrição fora das listas fica sem
  categoria. Não há detecção de parcela (`N/M`): não existe coluna para ela.
- **Reenvio troca a categoria.** Uma categoria enviada no item nunca é sobrescrita, mas se a mesma
  transação for reenviada, vale o que vier no último envio (o upsert já funcionava assim): reenviar
  sem categoria volta a inferida, mesmo que antes tivesse sido enviada uma.
- **Monitor pendente.** Fica para a entrega 2, porque precisa de um canal de alerta, que não existe.
- **Palavras-chave são heurística.** Só valem quando o classificador (LLM) falha e no modo mock;
  uma pergunta fora das listas pode não acionar o especialista certo nesse caminho.

## Defeitos do Python corrigidos

| # | Defeito no Python | Correção na versão TypeScript | Onde ver |
| --- | --- | --- | --- |
| 1 | Executores da inbox nunca registrados; inbox em memória; Executor fora do fluxo | Executor é nó do grafo; `ExecutorRegistry` registra executores (simulados) no boot; solicitações e execuções no Postgres | `modules/inbox`, [`inbox.int.spec.ts`](../apps/api/test/inbox/inbox.int.spec.ts) |
| 2 | Ação desconhecida tratada como reversível (executava sem aprovação) | Listas explícitas de `READ` e `REVERSIBLE`; **qualquer outra ação é `IRREVERSIBLE`** | [`risk.spec.ts`](../apps/api/src/modules/inbox/risk.spec.ts) |
| 3 | Modelo de reserva só no classificador | `withFallbacks()` em toda cadeia de modelo, com schema e tools aplicados a cada modelo | [`model-factory.spec.ts`](../apps/api/src/modules/llm/model-factory.spec.ts) |
| 4 | Cache de orquestradores ilimitado e histórico compartilhado entre requisições | Grafo sem estado em memória; histórico por thread no checkpointer, cortado: o checkpoint guarda as últimas 40 mensagens, os nós passam as últimas 20 aos agentes, e cada chamada ao modelo usa as últimas 12 | `modules/orchestrator`, `agents/agent.ts` |
| 5 | Orquestrador sem síntese | Nó `synthesize`; a falha de um especialista vira `{agent, error}` e a síntese menciona a análise que faltou | [`graph.spec.ts`](../apps/api/src/modules/orchestrator/graph.spec.ts) |
| 6 | Limites e cota por processo; cota não atômica | Janela deslizante e cota mensal no Redis, cada uma num único script Lua | [`limits.int.spec.ts`](../apps/api/test/limits/limits.int.spec.ts) |
| 7 | 500 sem tratamento; WebSocket expunha `str(exc)` | Filtro global RFC 9457 (`application/problem+json` com `traceId`); evento WS `error` só com `code` e `traceId` | [`problem-details.filter.spec.ts`](../apps/api/src/core/errors/problem-details.filter.spec.ts), [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) |
| 8 | `decided_by` em texto livre | Escopo `inbox:decide`; `decided_by_key_id` com FK composta (a chave tem de ser do mesmo tenant) | [`decision.e2e.spec.ts`](../apps/api/test/inbox/decision.e2e.spec.ts), [`inbox-integrity.int.spec.ts`](../apps/api/test/database/inbox-integrity.int.spec.ts) |
| — | Dinheiro em `float` | `numeric(18,2)` / `Decimal`, string decimal nos contratos; fee com arredondamento meio-para-cima | [`pricing.spec.ts`](../apps/api/src/modules/billing/pricing.spec.ts), [`billing.int.spec.ts`](../apps/api/test/billing/billing.int.spec.ts) |
| — | Chave de API na URL do WebSocket | Ticket de uso único (30 s) emitido por `POST /api/ws/ticket` | [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) |
| — | Ferramentas de lint sem versão fixada | Versões exatas em todos os `package.json` e lockfile congelado no CI | `pnpm install --frozen-lockfile` |

## Importação de arquivos (fase 2, entrega 1)

OFX, CSV e a planilha da Área do Investidor B3 entram por `POST /api/clients/:clientId/imports`
(fluxo, tabelas e eventos em [ARCHITECTURE.md](ARCHITECTURE.md#10-importação-de-arquivos-imports);
desenho original no [spec](superpowers/specs/2026-11-16-importacao-arquivos-design.md)). Decisões e
o motivo de cada uma:

| Tema | Decisão | Motivo (e alternativa descartada) |
| --- | --- | --- |
| Onde ficam os bytes | Tabela `import_file` no Postgres, sob RLS, apagada na mesma transação que fecha o job | Sobrevive a reinício e o isolamento vem do banco. No Redis (TTL) não haveria RLS e o job se perderia com o Redis; parse síncrono prenderia a API numa planilha de 10 MB |
| Parse | Assíncrono no `ImportWorker`, numa `worker_threads` encerrada aos 30 s e com heap limitada a 512 MB por padrão (`resourceLimits`, `IMPORT_PARSE_MAX_HEAP_MB`); estourar qualquer dos dois → `limit_exceeded` | Um arquivo hostil não trava o event loop do worker, não passa do tempo nem leva a memória do processo; encerrar a thread é o único jeito de interromper um parse síncrono |
| Mesmo arquivo | Mesmo SHA-256 no mesmo cliente → 200 com o job existente (`queued`, `parsing`, `done`); `failed` → o mesmo job é reenfileirado (202) | Nunca processa duas vezes nem cobra de novo, e um mapeamento errado ou uma queda do worker não deixam o arquivo impossível de importar. Vale o teto de 5 ativos (429, `Retry-After: 30`) também no reenvio, para o reenfileiramento não furar o limite |
| Arquivo vazio | 422; acima de 10 MB, 413 | Vazio é conteúdo inválido, não excesso de tamanho |
| Nada é "chutado" | Separador decimal e formato de data do CSV vêm do mapeamento; valor ou data ambíguos viram erro de linha | Gravar número errado em silêncio é pior do que recusar a linha |
| Chaves de idempotência | OFX `ofx:<banco>:<conta>:<FITID>`; CSV a coluna mapeada ou um hash de instituição, conta, data, valor, descrição e n-ésima ocorrência igual; B3 posição `b3:pos:<instituição>:<ativo>`, negociação e movimentação por hash da linha com a contagem de ocorrências | Reimportar o mesmo extrato (ou um sobreposto) não duplica, duas linhas idênticas legítimas não se fundem e contas diferentes não colidem |
| Posições da B3 | A planilha é uma fotografia: as posições `source = "import"` das instituições do arquivo são substituídas (remove as ausentes, upsert das presentes), por instituição, sob advisory lock por cliente; fotografia mais antiga que a gravada → nada substituído e as linhas viram `stale_snapshot`. Instituição com alguma linha de posição recusada só recebe o upsert das válidas, sem apagar nada (linha recusada sem instituição legível protege todas). Posições `api` e `synthetic` nunca são tocadas | Só com upsert, um ativo vendido entre duas fotografias ficaria na carteira para sempre. O lock serializa dois arquivos concorrentes, e a mais nova vence em qualquer ordem. Uma linha recusada pode ser de um ativo que continua na carteira: apagá-lo por causa de uma fórmula sem valor seria perder dado |
| `asOf` da B3 | Informado no upload | A planilha não traz uma data confiável nas células e o nome do arquivo não é dado |
| Cobrança | Cada lote gravado (até 1.000 itens) é um `data_ingestion` de R$ 0,05, pelo `IngestionService` (lote gravado ⇔ lote cobrado). Recusas síncronas e reenvio de arquivo já processado não cobram | Mesma regra da API de ingestão. Consequência: reprocessar um job que ficou `stuck` cobra de novo os lotes que ele regrava |
| Posse do job | `import_job.claim_token` (uuid novo a cada claim): `touchProgress` e `finish` só valem com o token do claim | Um worker que travou, foi marcado `stuck` e teve o arquivo reenviado não fecha nem avança o job que agora é de outro |
| Limpeza sob RLS | A migração 0008 cria `import_cleanup_tenant_ids()`, `SECURITY DEFINER`, que devolve só ids de tenants com arquivo vencido ou job parado (mesmo modelo de `active_tenant_ids`, 0004); cada tenant é limpo sob RLS como `carina_app` | `carina_app` não pode listar `import_file` de todos os tenants; sem a função, a limpeza não acharia o trabalho. A função não devolve conteúdo |
| Limpeza | `import_file` com mais de 1 h → apagada e job `failed` (`expired`); `parsing` sem progresso há mais de 15 min → `failed` (`stuck`) | Os bytes não podem ficar além do necessário (LGPD) e um job preso não pode ficar `parsing` para sempre |
| LGPD nos erros | Erro de linha é `{ row, field?, code, message }` com `message` fixa por `code`; log, auditoria e eventos levam só ids, contadores e códigos | Nunca o conteúdo de uma linha, um valor, uma descrição ou um nome de arquivo |
| Escopos | `data:write` para enviar, `chat` para ler; o seed dá `data:write` à chave da demo | Quem lê a carteira pode acompanhar a importação sem poder gravar |
| Presets de CSV | `nubank_conta` e `generico_br` | Um preset por layout conhecido; os demais vão por `csvMapping` |

### Limitações da importação

- **Sem arquivo real.** Os quatro formatos (OFX SGML e XML, CSV e a planilha da B3) foram
  reconstruídos da documentação pública (especificação OFX, layout conhecido do CSV da Nubank,
  planilhas da Área do Investidor B3); as fixtures são sintéticas. Um arquivo real pode quebrar um
  parser, e cada quebra vira erro de linha ou `failed` com código fixo, nunca número errado em
  silêncio.
- **PDF de nota de corretagem (SINACOR) e qualquer uso de LLM**: entrega 2. **OFX `INVSTMTRS`**
  (extrato de investimentos) não é suportado; o arquivo é recusado (`unsupported_ofx_investment`).
- **`externalId` mapeado no CSV é usado como veio.** Se a coluna mapeada não for única de fato, linhas
  distintas se sobrescrevem no upsert.
- **Limite de memória da thread de parse: 512 MB por padrão** (`IMPORT_PARSE_MAX_HEAP_MB`). Uma
  planilha de poucos MB pode passar disso ao ser expandida (uma de 5,78 MB chegou a 2,2 GB de
  heap sem limite) e termina como `failed`/`limit_exceeded`. Subir o limite exige memória
  sobrando no container do worker; a solução de fundo é ler as planilhas em streaming.
- **Worker travado que volta.** Um worker que trava e volta depois de o job ter sido retomado por
  outro pode ainda gravar (e cobrar) no máximo um lote em andamento; a gravação é upsert idempotente,
  então o efeito é só o lote regravado. O `claim_token` impede que ele grave os seguintes ou feche o
  job.
- **Reprocessar cobra de novo.** O reenvio de um job `failed` regrava todos os lotes, e os lotes já
  gravados antes da falha são cobrados outra vez (lote gravado ⇔ lote cobrado).
- **Sem mapeamento salvo por tenant**, e reprocessar um job com outro mapeamento exige subir o
  arquivo de novo.

## Garantias provadas por testes

Cada linha cita o arquivo e o teste que a prova. Os testes de integração e E2E rodam contra
Postgres e Redis reais (no CI, `pgvector/pgvector:pg17` e `redis:7-alpine`), conectados como
`carina_app`, que é `NOSUPERUSER NOBYPASSRLS`.

| Garantia | Teste |
| --- | --- |
| **Isolamento por RLS** entre tenants e entre clientes; fora de contexto, nada volta (falha fechada) | [`rls-isolation.int.spec.ts`](../apps/api/test/database/rls-isolation.int.spec.ts) (incl. "20 contextos em paralelo… nunca leem dados um do outro"); [`migrations.int.spec.ts`](../apps/api/test/database/migrations.int.spec.ts) ("SELECT em position sem app.tenant_id não devolve nada", "toda tabela de dados tem RLS com FORCE e política") |
| RLS na **busca vetorial/híbrida** (outro cliente do mesmo tenant e outro tenant não veem nada) | [`knowledge.int.spec.ts`](../apps/api/test/knowledge/knowledge.int.spec.ts) |
| Funções `SECURITY DEFINER` não podem ser **sombreadas por tabelas temporárias** | [`migrations.int.spec.ts`](../apps/api/test/database/migrations.int.spec.ts) (`resolve_api_key` e `resolve_api_key_by_id`), [`inbox-integrity.int.spec.ts`](../apps/api/test/database/inbox-integrity.int.spec.ts) (`active_tenant_ids`) |
| **Execução no máximo uma vez**: dois `executeOnce` em paralelo, o mesmo `resume` entregue duas vezes ou por dois workers, retomadas concorrentes do grafo | [`inbox.int.spec.ts`](../apps/api/test/inbox/inbox.int.spec.ts) ("dois em paralelo: o executor roda uma vez…"), [`resume.int.spec.ts`](../apps/api/test/orchestrator/resume.int.spec.ts) ("mesmo resume entregue duas vezes e por dois consumidores"), [`orchestrator.int.spec.ts`](../apps/api/test/orchestrator/orchestrator.int.spec.ts) ("retomadas concorrentes (duas instâncias)") |
| `started` preso vira `needs_review` e **nunca é reexecutado**; cobrança, auditoria e status revertem juntos | [`inbox.int.spec.ts`](../apps/api/test/inbox/inbox.int.spec.ts) (ReconciliationJob, "falha na cobrança…") |
| Decisões concorrentes: só uma vale; a segunda → 409 | [`inbox.int.spec.ts`](../apps/api/test/inbox/inbox.int.spec.ts), [`decision.e2e.spec.ts`](../apps/api/test/inbox/decision.e2e.spec.ts), [`full-flow.e2e.spec.ts`](../apps/api/test/flow/full-flow.e2e.spec.ts) |
| **Preço de servidor no `place_trade`**: um `valueBrl` incoerente do modelo não chega à aprovação nem à taxa (aprovação de R$ 3.000,00, execução cobra R$ 90,00); o payload da aprovação só tem as 8 chaves do servidor; ativo fora da tabela (`unknown_asset`) não cria aprovação; reexecução do nó no mesmo turno reutiliza a primeira cotação; `transfer` não cota | [`orchestrator.int.spec.ts`](../apps/api/test/orchestrator/orchestrator.int.spec.ts) ("R-M7: modelo com valueBrl incoerente…", "ordem padrão de PETR4…", "ativo desconhecido do provedor…", "reexecução do nó executor no mesmo turno…", "transfer não cota…"), [`trade-pricing.spec.ts`](../apps/api/src/modules/agents/trade-pricing.spec.ts) ("descarta toda chave do modelo fora do formato da ordem", "cotação de outro ativo → price_unavailable", "preço zero, negativo ou fora do formato nunca vira ordem", "exatamente na metade arredonda para cima: 3 × 10.005 = 30.015 → 30.02; 1.5 × 10.01 = 15.015 → 15.02") |
| **`place_trade` fora do formato nunca usa o valor do modelo**: com um executor que pula o `refineProposal` (payload malformado, vazio ou nome com espaços), o nó devolve `price_unavailable`, sem lookup, cotação nem aprovação | [`graph.spec.ts`](../apps/api/src/modules/orchestrator/graph.spec.ts) ("place_trade fora do formato vindo de um executor que pula o refineProposal…") |
| **Taxa e notional com 64 dígitos**: R$ 9.899.468.931.549.282,82 a 0,1234% dá fee de R$ 12.215.944.661.531,81 (com 20 dígitos daria ,82) | [`pricing.spec.ts`](../apps/api/src/modules/billing/pricing.spec.ts) ("precisão de 64 dígitos…", "quantidade × preço exato (64 dígitos)…") |
| **Cotação fresca ou nada** (falha fechada): mercado aberto aceita até 5 min e fechado até 5 dias, nos limites exatos; hora futura, preço zero e ativo ausente são recusados; cotação velha em cache provoca uma única nova busca; 20 `priceFor` concorrentes → 1 busca | [`market.service.spec.ts`](../apps/api/src/modules/market/market.service.spec.ts) ("MarketService.priceFor…", "preço zero (falha fechada)", "cotação velha do cache é buscada de novo uma vez"), [`market-service.int.spec.ts`](../apps/api/test/market/market-service.int.spec.ts) (cache de 60 s no Redis real) |
| **Mock e live não se misturam**: o modo entra na chave do cache; cotação com `source` de outro modo é ignorada no cache e recusada pelo `priceFor`; `MARKET_MODE=mock` em produção sobe com `warn` | [`market.service.spec.ts`](../apps/api/src/modules/market/market.service.spec.ts) ("mock e live não se misturam…"), [`market-core.int.spec.ts`](../apps/api/test/market/market-core.int.spec.ts) ("MARKET_LOGGER é provido pelo módulo…") |
| **Planos da brapi**: N símbolos com lote de K viram ceil(N/K) requisições com o mesmo cabeçalho; requisições em série (concorrência 1 por padrão); um lote falho não devolve resultado parcial; hora da cotação limitada a `now` | [`brapi.provider.spec.ts`](../apps/api/src/modules/market/providers/brapi.provider.spec.ts) ("lotes e chamadas em série…", "hora exatamente em now + 2 min passa…"), [`market-core.int.spec.ts`](../apps/api/test/market/market-core.int.spec.ts) ("live: lotes de MARKET_BRAPI_MAX_SYMBOLS_PER_CALL…") |
| **Cota do token protegida**: 20 chamadas com 20 símbolos desconhecidos → 1 busca por símbolo em 60 s (cache negativo); orçamento das rotas esgotado → 503 com `Retry-After` sem cobrança, enquanto o `priceFor` segue com orçamento próprio; zera no minuto seguinte; Redis fora → rotas 502, preço segue | [`market.service.spec.ts`](../apps/api/src/modules/market/market.service.spec.ts) ("cache negativo e orçamento…"), [`market-service.int.spec.ts`](../apps/api/test/market/market-service.int.spec.ts) ("orçamento das rotas no Redis real…"), [`market.e2e.spec.ts`](../apps/api/test/market/market.e2e.spec.ts) ("orçamento de chamadas ao provedor esgotado") |
| **Rotas `/api/market/*`**: sem `market:read` → 403; cada chamada bem-sucedida (inclusive acerto de cache) cobra `data_query` de R$ 0,05; entrada inválida → 422, provedor fora → 502 e orçamento esgotado → 503 com `Retry-After`, todos problem+json, sem cobrança e sem texto interno | [`market.e2e.spec.ts`](../apps/api/test/market/market.e2e.spec.ts) |
| **`MARKET_MODE` explícita no compose** (a API recusa subir em produção sem ela): `api`, `worker` e `seed` a definem, com padrão `mock` | [`toolchain.spec.ts`](../apps/api/src/toolchain.spec.ts) ("docker-compose.yml: MARKET_MODE") |
| **Importação: os bytes não sobram.** `import_file` fica vazia ao fechar o job (`done`, arquivo ilegível ou erro inesperado), e a limpeza apaga o arquivo com mais de 1 h marcando o job `expired` | [`imports.int.spec.ts`](../apps/api/test/imports/imports.int.spec.ts) ("OFX de ponta a ponta: done, transações source import, import_file vazio, 1 cobrança, data.ingested", "arquivo ilegível → failed/unreadable, sem bytes e sem cobrança", "erro inesperado → failed/internal, bytes apagados, evento confirmado (handle resolve)", "import_file de 2 h → expired (job mantido, bytes apagados); arquivo recente intocado") |
| **RLS em `import_file`**: outro tenant não lê nem apaga; com cliente fixado, o arquivo de outro cliente do mesmo tenant é invisível; INSERT com `tenant_id` alheio viola a política; o banco recusa bytes acima de 10 MB e a exclusão do job leva o arquivo | [`rls-isolation.int.spec.ts`](../apps/api/test/database/rls-isolation.int.spec.ts) ("tenant B não enxerga import_file de A em SELECT nem apaga em DELETE", "com cliente fixado, o import_file de outro cliente do mesmo tenant é invisível", "INSERT em import_file com tenant_id alheio viola a RLS"), [`migrations.int.spec.ts`](../apps/api/test/database/migrations.int.spec.ts) ("import_file: bytes acima de 10 MB são recusados (23514); 10 MB exatos passam", "apagar o import_job apaga o import_file (ON DELETE CASCADE)") |
| **Importação: sem conteúdo em log, erro, auditoria nem evento.** A descrição de uma transação da fixture não aparece em nenhum deles; a mensagem de erro de linha é fixa (sem interpolação); a de erro de opções não repete o valor enviado; o erro da thread de parse leva só o nome | [`imports.int.spec.ts`](../apps/api/test/imports/imports.int.spec.ts) ("nenhum log, erro de linha, auditoria ou evento contém a descrição de uma transação da fixture"), [`row-errors.spec.ts`](../apps/api/src/modules/imports/parsers/row-errors.spec.ts) ("não tem interpolação"), [`imports.service.spec.ts`](../apps/api/src/modules/imports/imports.service.spec.ts) ("a mensagem de erro de opções não repete o valor enviado"), [`parse-file.spec.ts`](../apps/api/src/modules/imports/parse-file.spec.ts) ("erro dentro da thread → ParseThreadError só com o nome do erro (nunca a mensagem)") |
| **Importação idempotente**: o mesmo arquivo → 200 com o mesmo job, sem novo evento nem cobrança; envios concorrentes criam um job só; reentrega do `import.requested` e dois handles concorrentes processam uma vez; reenviar depois de `stuck` termina `done` sem duplicar; o `externalId` derivado é estável | [`imports.e2e.spec.ts`](../apps/api/test/imports/imports.e2e.spec.ts) ("o mesmo arquivo de novo: 200 com o mesmo id, sem novo job, evento nem cobrança", "uploads concorrentes do mesmo arquivo criam um job só"), [`imports.int.spec.ts`](../apps/api/test/imports/imports.int.spec.ts) ("reentrega do mesmo import.requested não processa de novo (claim)", "dois handles concorrentes do mesmo evento: só um processa", "reenvio após stuck: lote 1 gravado, worker caiu → limpeza marca stuck → reenvio → done sem duplicar"), [`external-id.spec.ts`](../apps/api/src/modules/imports/parsers/external-id.spec.ts) ("é estável") |
| **Reenvio de job `failed`**: o mesmo job volta a `queued` com opções novas, bytes regravados e contadores zerados; com 5 ativos o reenvio dá 429 com `Retry-After` e o job `failed` fica intacto | [`imports.e2e.spec.ts`](../apps/api/test/imports/imports.e2e.spec.ts) ("job failed + reenvio: 202 com o mesmo id, opções novas, bytes regravados, zerado, novo evento", "5 ativos + reenvio de um failed: 429 com Retry-After e o job failed fica intacto"), [`imports.service.spec.ts`](../apps/api/src/modules/imports/imports.service.spec.ts) ("5 ativos + failed existente: 429 sem reenfileirar") |
| **Limites da importação**: vazio → 422, acima de 10 MB → 413 (e 10 MB exatos passam), sexto job ativo → 429 com `Retry-After`; zip bomb e razão de compressão recusados sem inflar; mais de 100 000 linhas → `limit_exceeded`; o parse é encerrado aos 30 s; a thread que estoura a heap termina em `limit_exceeded` | [`imports.e2e.spec.ts`](../apps/api/test/imports/imports.e2e.spec.ts) ("arquivo ausente ou vazio: 422", "acima de 10 MB: 413 problem+json, nada gravado", "exatamente 10 MB passa", "sexto job ativo: 429 com Retry-After; o mesmo arquivo já enfileirado ainda responde 200"), [`xlsx-reader.spec.ts`](../apps/api/src/modules/imports/parsers/xlsx-reader.spec.ts) ("zip bomb (entrada que declara 60 MB) é recusado como limite, sem inflar", "razão de compressão acima de 200 é recusada"), [`csv.spec.ts`](../apps/api/src/modules/imports/parsers/csv.spec.ts) ("mais de 100 000 linhas -> limit_exceeded"), [`parse-file.spec.ts`](../apps/api/src/modules/imports/parse-file.spec.ts) ("parser que dorme 31 s: a thread é encerrada aos 30 s → limit_exceeded (relógio fake)", "thread que estoura a memória (ERR_WORKER_OUT_OF_MEMORY) → limit_exceeded, não erro") |
| **Substituição de posições da B3**: a posição importada das instituições do arquivo é substituída, `api` e `synthetic` ficam intactas; fotografia mais antiga não substitui nada (`stale_snapshot`, sem cobrança nem evento); duas importações concorrentes terminam com a mais nova, em qualquer ordem | [`ingestion.int.spec.ts`](../apps/api/test/data-ingestion/ingestion.int.spec.ts) ("remove o ativo vendido da mesma instituição; preserva outra instituição e source api/synthetic", "keepInstitutions: grava, mas não apaga nada dessas instituições", "fotografia mais antiga: stale, nada muda, nenhuma cobrança, nenhum evento", "concorrência: a fotografia mais nova vence em qualquer ordem de chegada, sem união"), [`imports.int.spec.ts`](../apps/api/test/imports/imports.int.spec.ts) ("B3: a posição importada das instituições do arquivo é substituída; api intocada", "B3: linha recusada (fórmula sem valor) não apaga a posição anterior do ativo; a instituição só recebe as válidas", "B3 com fotografia mais antiga que a gravada: stale_snapshot em todas, nada substituído → no_valid_rows") |
| **Cobrança por lote da importação**: 2.500 transações → 3 lotes, 3 cobranças, progresso 1000/2000/2500 | [`imports.int.spec.ts`](../apps/api/test/imports/imports.int.spec.ts) ("CSV de 2 500 transações → 3 lotes, 3 cobranças, progresso 1000/2000/2500") |
| **Worker travado perde o job**: depois de `stuck` e reenvio, o worker antigo não avança nem fecha o job tomado por outro (`claim_token`); a limpeza só enxerga tenants com trabalho, sob lock global | [`imports.int.spec.ts`](../apps/api/test/imports/imports.int.spec.ts) ("worker travado (não morto) perde o job: stuck → reenvio → outro claim; o antigo não avança nem fecha", "limpeza: só enxerga tenants com trabalho; outro tenant não é tocado; lock global") |
| **Isolamento da importação entre tenants**: o mesmo arquivo em tenants diferentes gera jobs independentes; job de outro tenant → 404; escopos `data:write`/`chat`; o progresso só chega ao socket do mesmo tenant e cliente | [`imports.e2e.spec.ts`](../apps/api/test/imports/imports.e2e.spec.ts) ("o mesmo arquivo em tenants diferentes gera jobs independentes", "job de outro tenant, id inexistente ou malformado: 404; sem escopo: 403", "chave sem data:write: 403; sem chave: 401"), [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) ("socket do cliente recebe import_progress e import_finished done; outro tenant não recebe nada") |
| **No máximo 3 especialistas por turno**, na ordem fixa do plano, na heurística e no `normalizePlan`; uma pergunta que casa 5 áreas roda só 3 | [`heuristic.spec.ts`](../apps/api/src/modules/orchestrator/heuristic.spec.ts) ("corta em 3 na ordem fixa: imposto + risco + aposentadoria + projeção + assessor → [risk, predictor, strategist]", "normalizePlan corta em 3 e mantém a ordem do modelo depois de deduplicar"), [`chat.e2e.spec.ts`](../apps/api/test/chat/chat.e2e.spec.ts) ("pergunta que casa 5 áreas roda só 3 especialistas") |
| **Palavras-chave sem falso positivo**: "IR" sozinho, o verbo "ir" e "impostor" não acionam o `tax`; "imposto de renda", "IRPF" e "declaração de IR" (com espaços múltiplos) acionam; "metade", "cometa", "irmão" e "assessoria" não acionam ninguém | [`heuristic.spec.ts`](../apps/api/src/modules/orchestrator/heuristic.spec.ts) ("'(IR)' sozinho não aciona tax (minúsculas perdem a caixa); 'ir' verbo e 'impostor' também não", "\"imposto de renda\" → tax (frase fixada, além de impostos?)", "declaração de IR tolera espaços múltiplos entre as palavras", "tax: declaração de IR, IRPF, impostos e pós-imposto", "limite de palavra: metade, cometa, irmão, assessoria não acionam ninguém") |
| **Saída forjada dos novos especialistas é recusada**: alocação que soma 90, `pct` ou `successProbability` fora da faixa, IR negativo, seis perguntas ao assessor e listas ou textos grandes demais viram `AllProvidersFailedError`; os limites exatos passam | [`agents.spec.ts`](../apps/api/src/modules/agents/agents.spec.ts) ("strategist recusa alocação que soma 90 → AllProvidersFailedError", "strategist aceita soma 100 e a tolerância de 0,5", "strategist recusa successProbability fora de 0..1", "tax recusa estimatedTaxBrl negativo", "tax aceita IR zero e o máximo de 16 dígitos", "assessor_liaison recusa 6 perguntas e item com 501 caracteres", "assessor_liaison aceita 5 perguntas de 500 caracteres"); schemas em [`agents.spec.ts`](../packages/shared/src/agents.spec.ts) ("StrategyPlan recusa successProbability 1.5 e byYear 1999", "TaxAdvice exige Money em estimatedTaxBrl e consultAccountant boolean", "AssessorBrief exige de 1 a 5 perguntas") |
| **Prompts dos novos agentes**: terminam com o aviso de conteúdo não confiável; o researcher diz que não tem acesso à web e o assessor_liaison que só redige e lista o que revela | [`agents.spec.ts`](../apps/api/src/modules/agents/agents.spec.ts) ("todos os prompts novos terminam com o aviso de conteúdo não confiável", "prompt do researcher diz que não tem acesso à web", "prompt do assessor_liaison diz que só redige e lista o que é revelado") |
| **Pergunta de imposto de ponta a ponta (mock)**: plano com `tax`, `agent_result` válido em `TaxAdviceSchema` e síntese | [`chat.e2e.spec.ts`](../apps/api/test/chat/chat.e2e.spec.ts) ("pergunta de imposto: plano com tax, resultado válido em TaxAdviceSchema e síntese") |
| **Categorizer**: `kind` vence a descrição; Mercado Livre, Mercado Pago, "mercado financeiro", Uberlândia, "aguardando" e "R$ 199,00" não casam; acento decomposto casa; sem regra → `null` | [`categorize.spec.ts`](../apps/api/src/modules/data-ingestion/categorize.spec.ts) (tabela `categorize`: "kind vence a descrição", "Mercado Livre não é alimentação", "Mercado Pago não é alimentação", "Uberlândia não casa uber", "R$ 199,00 não casa 99", "FARMÁCIA em NFD → saúde", "texto sem regra → null") |
| **Categoria enviada nunca é sobrescrita**, e sem regra o item não ganha "outros" | [`categorize.spec.ts`](../apps/api/src/modules/data-ingestion/categorize.spec.ts) ("mantém a categoria enviada e não inventa 'outros'"), [`ingestion.int.spec.ts`](../apps/api/test/data-ingestion/ingestion.int.spec.ts) ("transação sem categoria é gravada com a inferida; com categoria enviada, a enviada prevalece") |
| **Categorização idempotente**; no reenvio da mesma transação vale o último envio | [`ingestion.int.spec.ts`](../apps/api/test/data-ingestion/ingestion.int.spec.ts) ("reenviar o lote sem categoria grava a inferida de novo (idempotente)", "reenvio com e sem categoria: vale a do último envio") |
| **Importação categorizada**: o OFX importado sai com categorias onde a regra casa | [`imports.int.spec.ts`](../apps/api/test/imports/imports.int.spec.ts) ("OFX importado sai com categorias inferidas onde a regra casa") |
| **Cartões dos novos agentes**: strategist, tributário (aviso de contador só com `consultAccountant`), assessor (todo o `sharedData` e o aviso de que nada foi enviado) e pesquisa; resultado fora do schema cai no render genérico | [`ChatView.test.tsx`](../apps/web/src/features/chat/ChatView.test.tsx) ("cartão tributário mostra o IR em R$ e o aviso de contador só com consultAccountant", "cartão do assessor numera as perguntas e avisa que nada foi enviado", "cartão do assessor mostra os dados compartilhados além das perguntas", "cartão do assessor avisa quando a pergunta não tem o que revela", "resultado fora do schema cai no render genérico") |
| **Fluxo completo** pela fiação de produção: 403 sem `inbox:decide`, execução pelo ResumeWorker, R$ 90,00 cobrados, auditoria, inbox vazia e isolamento de um segundo tenant | [`full-flow.e2e.spec.ts`](../apps/api/test/flow/full-flow.e2e.spec.ts) |
| **Retomada entre tenants impossível**; eventos forjados não executam nada | [`orchestrator.int.spec.ts`](../apps/api/test/orchestrator/orchestrator.int.spec.ts) ("outro tenant não retoma nem lê o thread"), [`resume.int.spec.ts`](../apps/api/test/orchestrator/resume.int.spec.ts) ("eventos forjados ou venenosos…") |
| **Append-only**: em `usage_record` e `audit_event`, o INSERT do `carina_app` passa e UPDATE, DELETE e TRUNCATE falham com 42501 (permission denied) | [`migrations.int.spec.ts`](../apps/api/test/database/migrations.int.spec.ts); pelo cliente Prisma do serviço (UPDATE e DELETE recusados): [`watchtower.int.spec.ts`](../apps/api/test/watchtower/watchtower.int.spec.ts) |
| A auditoria guarda a pergunta com **CPF, CNPJ, e-mail, telefone e cartão mascarados** e truncada em 500 caracteres, e a resposta **só como digest** (nunca o texto) | [`mask-pii.spec.ts`](../apps/api/src/modules/watchtower/mask-pii.spec.ts), [`watchtower.e2e.spec.ts`](../apps/api/test/watchtower/watchtower.e2e.spec.ts) ("a pergunta gravada é mascarada…"), [`watchtower.int.spec.ts`](../apps/api/test/watchtower/watchtower.int.spec.ts) |
| **Ticket WS de uso único**; vencido ou malformado → 4401 | [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) ("ticket reutilizado…") |
| **Chave revogada, escopo removido ou tenant suspenso com o socket aberto**: o próximo turno é recusado e o socket fecha; um socket **ocioso** é revalidado a cada heartbeat, para de receber o push da inbox e fecha com 4401 | [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) ("Chat WebSocket: revalidação da chave e tempo máximo de vida" e "revogação com o socket ocioso") |
| A **mesma ordem pedida de novo** no mesmo thread é um pedido novo (id da aprovação inclui o turno): nova aprovação pendente, executada só depois da decisão | [`orchestrator.int.spec.ts`](../apps/api/test/orchestrator/orchestrator.int.spec.ts) ("a mesma ordem repetida no mesmo thread") |
| Aprovação `approved` **órfã** (o thread não espera por ela, conferido no checkpoint pelo worker) termina em `needs_review`, auditada, sem executar. Uma aprovação **esperada** nunca é fechada pela reconciliação: depois de 1 h segue republicada com backoff e aviso, e executa quando o worker volta. Uma espera presa por execução já terminal é curada no próximo turno, sem executar | [`resume.int.spec.ts`](../apps/api/test/orchestrator/resume.int.spec.ts) ("aprovação aprovada órfã", "aprovada e ESPERADA pelo thread além de 1 h", "execução já terminal (needs_review)", "corrida: fechamento de órfã…") |
| O broadcast da inbox só chega ao socket do **mesmo tenant e cliente** | [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) ("broadcast da inbox") |
| **Streams**: retentativa, DLQ após 5 entregas, dedup por `eventId`, entrada inválida não derruba o loop | [`streams.int.spec.ts`](../apps/api/test/redis/streams.int.spec.ts), [`resume.int.spec.ts`](../apps/api/test/orchestrator/resume.int.spec.ts) |
| **Ingestão idempotente**: o mesmo lote duas vezes não duplica; lote cobrado ⇔ lote gravado | [`ingestion.e2e.spec.ts`](../apps/api/test/data-ingestion/ingestion.e2e.spec.ts) |
| **Limites atômicos**: 50 `reserve` concorrentes com cota 10 → exatamente 10; 429 sempre com `Retry-After` | [`limits.int.spec.ts`](../apps/api/test/limits/limits.int.spec.ts) |
| **Watchtower sem ReDoS**: tempo linear em entradas adversariais de 1 MB; paridade com o Python | [`inspect-text.perf.spec.ts`](../apps/api/src/modules/watchtower/inspect-text.perf.spec.ts), [`inspect-text.parity.spec.ts`](../apps/api/src/modules/watchtower/inspect-text.parity.spec.ts) |
| Logs **sem chave, ticket nem query string**; requisições levam `tenantId`/`keyId` | [`health.e2e.spec.ts`](../apps/api/test/health/health.e2e.spec.ts) ("logs de requisição") |
| Provedores fora: REST → 503 com `Retry-After`; WS → evento `error` sem texto interno; nos dois, cota devolvida e nada cobrado | [`chat.e2e.spec.ts`](../apps/api/test/chat/chat.e2e.spec.ts), [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) |

## Como rodar os testes

Requisitos: Node 22.22.2 (`.nvmrc`) e pnpm 10 (`corepack enable` ou `npm i -g pnpm@10.28.0`).

```bash
pnpm install
pnpm lint && pnpm typecheck
pnpm test                              # unidade: api, shared e web
pnpm --filter @carina/api test:int     # integração (Postgres + Redis reais)
pnpm --filter @carina/api test:e2e     # E2E da API (Supertest + WebSocket, LLM_MODE=mock)
pnpm --filter @carina/api test:cov     # unit + int + e2e com cobertura (limite: 80% de linhas em src/modules)
pnpm build
```

Integração e E2E precisam de um Postgres com pgvector e de um Redis:

- **Com Docker e sem nenhuma variável**, o harness sobe `pgvector/pgvector:pg17` e
  `redis:7-alpine` via Testcontainers.
- **Com serviços próprios** (é o que o CI faz), aponte para eles:

  ```bash
  export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres  # superusuário
  export TEST_REDIS_URL=redis://localhost:6379
  ```

  O harness cria um banco novo por execução e projeto, cria os papéis `carina_migrator` e
  `carina_app` se faltarem (nunca altera papéis existentes), aplica as migrações e remove o
  banco no fim.
- **`TEST_DB_ICU_LOCALE=en-US`** (opcional, PostgreSQL ≥ 15) cria o banco de teste com
  collation ICU, para reproduzir localmente a ordenação de texto do CI (`en_US.utf8`) num
  Postgres local em `C.UTF-8`.

Cada arquivo de teste usa um DB lógico próprio do Redis
([`redis-dbs.ts`](../apps/api/test/setup/redis-dbs.ts)), e os projetos `unit` → `int` → `e2e` rodam
em sequência numa execução única.

O CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) tem três jobs:

- `typescript`: lint, typecheck, unidade, integração, E2E, cobertura e build, com service
  containers PG17 + pgvector e Redis 7;
- `compose-smoke`: `docker compose up --wait` sem chaves de API e o roteiro de aprovação pelo
  proxy do web;
- `legacy-python`: os testes da versão antiga.

## Segurança: o que saber antes de expor

Esta é uma demo de portfólio, não um serviço pronto para produção. Pontos a conhecer:

- **PII vai ao provedor de LLM no modo live.** Os prompts levam a pergunta e trechos da base de
  conhecimento do cliente (posições, transações, instituições) para OpenRouter/Groq, e os textos a
  indexar para a NVIDIA. No modo mock nada sai da máquina.
- **As chaves de demo são públicas.** Veja [Demo local](../README.md#demo-local). Gere chaves novas fora dela.
  As chaves ficam no banco só como sha256 e nunca vão para os logs.
- **Ticket do WebSocket na query string.** A chave nunca vai na URL; o ticket vai em
  `/ws/chat?ticket=…`. Ele vale 30 s e uma vez só, e o nginx da demo não grava access log de
  `/ws/`. Um reverse proxy seu deve fazer o mesmo (ou mascarar a query), porque um ticket ainda
  não usado que vaze nos logs pode abrir uma sessão dentro da janela de 30 s.
- **Sem allow-list de `Origin` no WebSocket.** O ticket é a autenticação e é obtido com a chave
  num header, que outro site não consegue ler. Mesmo assim, uma checagem de `Origin` seria defesa
  em profundidade.
- **Suspensão de tenant sem API administrativa.** `tenant.suspended_at` funciona (REST → 401;
  sockets abertos fecham no próximo turno ou heartbeat), mas hoje só se altera direto no banco.
- **Implantação da importação.** (1) O multer recusa o arquivo acima de 10 MB, mas ainda lê e
  descarta o corpo oversize: ponha um limite de corpo no reverse proxy. O nginx da demo
  ([`nginx.conf`](../apps/web/nginx.conf)) não define `client_max_body_size`, então vale o padrão
  dele (1 MB): pelo painel web da demo, arquivos acima de 1 MB recebem 413 do nginx antes de chegar à
  API. Para a API aceitar até 10 MB atrás dele, defina `client_max_body_size 11m;` em `location /api/`. (2) A migração 0008 foi editada no lugar antes do lançamento: quem
  aplicou uma versão anterior dela nesta branch precisa de um banco novo. (3) Os bytes ficam no banco
  por segundos (até 1 h no pior caso, antes da limpeza), então o backup do Postgres pode conter um
  arquivo em trânsito.
- **O valor que define a taxa de execução é afirmado pelo modelo só em `transfer` e `rebalance`.**
  Para elas o `valueBrl` vem da saída do LLM: é validado (formato, sinal, limite de
  `numeric(18,2)`) e, quando o payload traz como conferir (valor explícito, ou quantidade × preço
  unitário), tem de bater, senão a proposta é recusada. O aprovador vê o valor junto com o payload
  antes de decidir, mas não há fonte de preço para essas ações.
- **`place_trade`: o servidor vence.** Com um código de ativo válido, o nó `executor` cota o ativo
  (`MarketService.priceFor`), monta o payload com a allow-list de 8 chaves (`side`, `assetCode`,
  `quantity`, `unitPriceBrl`, `notionalBrl`, `priceSource`, `priceAsOf`, `marketState`) e calcula
  `valueBrl = quantidade × preço` (exato, meio para cima, 2 casas). Qualquer chave de valor ou de
  preço do modelo é descartada. Falha fechada: sem cotação (`price_unavailable`), velha
  (`price_stale`) ou de ativo desconhecido (`unknown_asset`), nenhuma aprovação é criada e a
  resposta do turno traz uma frase fixa por código. Limites conhecidos: a taxa na execução é
  calculada sobre o `valueBrl` gravado, o que o aprovador viu, sem nova cotação (o preço pode
  ter mudado em até `APPROVAL_TTL_HOURS`); não há calendário de feriados (um feriado parece
  pregão aberto, e a cotação velha é recusada como `price_stale`); a frase de falha entra no
  `answer`, não nas mensagens do checkpoint.
- **Implantação do preço de servidor: aprovações pendentes antigas.** Uma aprovação de
  `place_trade` criada antes do deploy desta versão carrega o `valueBrl` afirmado pelo modelo e,
  se aprovada, será cobrada sobre ele (a execução usa o valor gravado). Antes do deploy, decida as
  pendentes de `place_trade` ou espere `APPROVAL_TTL_HOURS` (padrão 24 h) para elas expirarem.
- **CSP do web**: `connect-src 'self'`. Pela CSP Level 3, `'self'` cobre o `ws:`/`wss:` da mesma
  origem; verificamos isso no Chromium. Um navegador antigo que não siga a CSP3 bloquearia o
  WebSocket.
- O papel de runtime (`carina_app`) não tem `BYPASSRLS` e não lê `api_key`. A autenticação passa
  por funções `SECURITY DEFINER` com `search_path` fixo.

## Limitações conhecidas e próximos passos

O que **não** está feito ou tem limite conhecido na fase 1:

- **Executores simulados.** `place_trade`, `transfer` e afins devolvem ids simulados; não há
  integração com corretora. No mock, o preço do `place_trade` vem de uma tabela fixa (PETR4 a R$ 30,00).
- **Modo live de mercado sem teste no CI.** `BrapiProvider` e `BcbProvider` são testados com
  fixtures reconstruídas da documentação (o sandbox de desenvolvimento não alcançava brapi.dev nem
  o BCB), nunca contra a rede. O script manual `pnpm --filter @carina/api market:smoke` (depois do
  `pnpm build`) busca PETR4 e os quatro indicadores do BCB; rodá-lo uma vez com rede e registrar
  as respostas reais é um acompanhamento pendente. No mock, só os tickers da tabela
  (`MOCK_PRICES`) têm preço; qualquer outro vira `unknown_asset` na demo.
- **Planos da brapi.dev e configuração do live.** Segundo a documentação da brapi (conferida em
  2026-11-14): Gratuito, 1 ativo por requisição, 1 requisição simultânea, dados com ~30 min de
  atraso e histórico de até 3 meses; Startup, 10 ativos, 4 simultâneas, ~15 min, 1 ano; Pro, 20
  ativos, 16 simultâneas, ~5 min; sem token só PETR4, MGLU3, VALE3 e ITUB4 respondem, a 20
  requisições por minuto por IP. Os padrões (`MARKET_BRAPI_MAX_SYMBOLS_PER_CALL=1`,
  `MARKET_PROVIDER_CONCURRENCY=1`) cabem em todos os planos. `MARKET_QUOTE_MAX_AGE_MS` continua
  com 5 min, mas precisa ser pelo menos o atraso do plano (ex.: ~35 min no Gratuito): abaixo
  disso o live recusa toda ordem em pregão como `price_stale` (falha fechada). Histórico além do
  que o plano permite volta como erro do provedor (502). O orçamento por minuto
  (`MARKET_PROVIDER_MAX_CALLS_PER_MIN` e `MARKET_PRICE_MAX_CALLS_PER_MIN`, 30 cada) limita a
  queima da cota mensal, mas não a confere: dimensione-o pela cota do plano.
- **Modo live sem teste automatizado.** A cadeia de fallback é testada com modelos falsos; os ids
  `:free` do OpenRouter em `models.yaml` têm `TODO confirmar` e podem mudar.
- **Agentes:** navigator, insight, predictor, risk, strategist, tax, researcher, assessor_liaison
  e executor no chat, mais o categorizer na ingestão. Falta o monitor (entrega 2); ver
  [Limitações dos agentes restantes](#limitações-dos-agentes-restantes-e-do-categorizer). Os docs [`AGENTS.md`](AGENTS.md), [`B2B.md`](B2B.md) e
  [`DEPLOYMENT.md`](DEPLOYMENT.md) ainda descrevem a versão Python e a visão de produto.
- **Conversa guardada no checkpoint.** O schema `langgraph` guarda as mensagens da conversa
  (perguntas e respostas, em texto) sem RLS (são tabelas da biblioteca), sem TTL e sem limpeza em
  cascata por cliente. O thread é `tenant:cliente:uuid`, e a API nunca expõe nem retoma thread de
  outro tenant, mas os dados ficam lá.
- **Sem caminho de eliminação (LGPD).** Não há rota nem rotina para apagar os dados de um cliente
  final (posições, transações, conhecimento, checkpoints). A auditoria é append-only por desenho.
- **Mascaramento de PII por padrões.** A pergunta auditada tem CPF, CNPJ, e-mail, telefone e
  cartão mascarados; nomes, endereços e PII em formato livre continuam passando. No modo live, o
  contexto do cliente vai ao provedor de LLM (ver [Segurança](#segurança-o-que-saber-antes-de-expor)).
- **Re-sync completo por lote.** Cada lote de ingestão dispara um Sync completo do cliente (sem
  coalescência), o que custa caro num backfill grande.
- **Auditoria com o uuid interno do cliente.** `GET /api/audit` devolve o `clientId` interno,
  enquanto as outras rotas usam o `externalId`.
- **Turno que termina depois de o cliente desconectar** é cobrado, mas a resposta não pode ser
  recuperada pela API.
- **Streams sem `MAXLEN`.** `jobs`, `inbox.events` e as DLQs crescem sem limite.
- **Atualização após aprovar.** Na UI, o painel de uso só se atualiza no fim de um turno de chat
  ou pelo botão "Atualizar", não quando chega `approval_executed`.
- **Uma instância só foi exercitada na demo.** Réplicas são seguras por desenho e por teste
  (consumidores concorrentes, locks), mas não houve teste de carga.

Próximos passos de engenharia, em ordem de prioridade:

1. API administrativa para suspender tenant e revogar chave (hoje, só direto no banco).
2. `MAXLEN`/trim dos streams e offset inicial dos consumer groups.
3. Nomes de consumer estáveis por réplica, ou `XGROUP DELCONSUMER` dos ociosos (hoje cada
   processo cria um nome novo).
4. Mapear erros do Prisma/Postgres (42501, P2002, classe 22) para Problem Details específicos, em
   vez de 500 genérico.
5. Limite para a criação de `client`: hoje cada `clientId` novo num ticket ou chat cria um cliente.
6. `MODELS_CONFIG_PATH` dentro do `EnvSchema` (hoje é lida fora da validação).
7. Reconciliação: trocar as políticas SELECT da migração 0004 (por `current_user`/`session_user`)
   por um papel dedicado `carina_reconciler`, ou cobri-las com um teste de catálogo.
8. Remover código morto restante: `ExecutorAgent.request`, `INSTITUTIONS`,
   `MODEL_FACTORY_OPTIONS`.
9. Alinhar a classe de erro do modo mock (`ValidationError`) com a do live
   (`AllProvidersFailedError`) para saída fora do schema.

