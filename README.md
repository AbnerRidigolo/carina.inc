# CARINA — núcleo multiagente de gestão patrimonial em TypeScript

O CARINA é uma API B2B multi-tenant de inteligência financeira para bancos, fintechs e gestoras.
O cliente final faz uma pergunta sobre a própria carteira, um orquestrador aciona agentes
especialistas em paralelo e responde com streaming. Quando o pedido é uma **ação irreversível**
(por exemplo, uma ordem de compra), o grafo pausa até que uma pessoa com o escopo certo aprove. A
execução acontece **no máximo uma vez** e fica cobrada e auditada.

Este repositório é a **fase 1** da migração do CARINA de Python para TypeScript/Node.js: o núcleo
apresentável. A versão Python continua em [`legacy/python`](legacy/python) até a fase 3.

**Stack:** NestJS 12 · React + Vite · PostgreSQL 17 + pgvector + Prisma 7 (isolamento por RLS) ·
Redis (limites atômicos, Streams) · LangGraph.js / LangChain.js · Zod compartilhado entre API e web
· Vitest contra Postgres e Redis reais.

- [Demo local](#demo-local)
- [Importação de arquivos](#importação-de-arquivos)
- [Monitor de carteira](#monitor-de-carteira)
- [Arquitetura](#arquitetura)
- [Garantias provadas por testes](#garantias-provadas-por-testes)
- [Como rodar os testes](#como-rodar-os-testes)
- [Limitações e segurança](#limitações-e-segurança)
- [Roadmap](#roadmap)

## Demo local

Pré-requisito: Docker com Compose v2. **Nenhuma chave de API é necessária**: a demo roda com
`LLM_MODE=mock`, em que modelos determinísticos substituem os provedores.

```bash
docker compose up --build
```

Abra http://localhost:5173 (web). A API responde em http://localhost:3000/api/health e
`/api/ready`. Todas as portas são publicadas só em `127.0.0.1`. Ordem de subida: `postgres` e
`redis` → `migrate` → `seed` → `api` → `web`; o `worker` (sync, retomada de aprovações,
reconciliação e monitor de carteira) sobe depois do `migrate`.

Se você já tinha subido a demo antes de o tenant de demo ganhar id fixo, apague os volumes antigos
com `docker compose down -v` antes de subir de novo. Sem isso, o seed falha com
"DEMO_APP_KEY já pertence a outro tenant".

O seed cria o tenant `demo`, três clientes sintéticos já sincronizados com a base de conhecimento
(`cliente-conservador`, `cliente-moderado` e `cliente-arrojado`) e duas chaves:

| Variável            | Valor padrão                               | Escopos                                                           |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `DEMO_APP_KEY`      | `sk-live-demoapp0000000000000000000000000` | `chat`, `data:write`, `market:read`, `eval:run`, `builder:run`    |
| `DEMO_APPROVER_KEY` | `sk-live-demoapprover00000000000000000000` | `chat`, `inbox:decide`                                            |

> **Essas chaves são públicas (estão neste repositório) e servem só para a demo local.** Com
> `NODE_ENV=production` o seed recusa as chaves fixas, a menos que `SEED_ALLOW_DEMO_KEYS=true`.
> Só o compose de demo liga essa opção. Fora da demo, defina `DEMO_APP_KEY` e
> `DEMO_APPROVER_KEY` com chaves novas. Todas as variáveis estão em [.env.example](.env.example).

### Roteiro de 2 minutos

1. Conecte com a `DEMO_APPROVER_KEY` e pergunte "Como está minha carteira?". O Insight roda e o
   Navigator responde em streaming, com o custo do turno.
2. Peça "compre 100 ações de PETR4". O executor cota PETR4 no servidor (R$ 30,00 na tabela do mock),
   propõe a ordem de R$ 3.000,00, o grafo pausa e a aprovação aparece no painel.
3. Aprove e confirme. O `worker` retoma o grafo e executa a ordem simulada uma vez. O painel recebe
   `approval_executed` pelo WebSocket e o uso mostra a execução: R$ 90,00 (R$ 75,00 de preço base
   + 0,5% de R$ 3.000,00).

O mesmo roteiro pela API:

```bash
APP="Authorization: Bearer sk-live-demoapp0000000000000000000000000"
APPROVER="Authorization: Bearer sk-live-demoapprover00000000000000000000"
curl -s -X POST localhost:3000/api/chat -H "$APP" -H 'Content-Type: application/json' \
  -d '{"clientId":"cliente-moderado","message":"compre 100 ações de PETR4"}'   # → awaiting_approval
curl -s -X POST localhost:3000/api/inbox/<approval.id>/decision -H "$APPROVER" \
  -H 'Content-Type: application/json' -d '{"approved":true}'                  # → approved
curl -s localhost:3000/api/usage -H "$APP"                                    # → execution: 90.00
```

Com a chave app, a decisão devolve **403**: ela não tem `inbox:decide`. Esse roteiro roda no CI
(job `compose-smoke`) e no teste
[`full-flow.e2e.spec.ts`](apps/api/test/flow/full-flow.e2e.spec.ts).

Dados de mercado (escopo `market:read`, que a chave app da demo tem):

```bash
curl -s "localhost:3000/api/market/quotes?symbols=PETR4,VALE3" -H "$APP"
# → {"quotes":[{"symbol":"PETR4","price":"30.00",...,"source":"mock"}, ...],"usage":{"workType":"data_query","priceBrl":"0.05"}}
curl -s localhost:3000/api/market/macro -H "$APP"
```

`GET /api/market/history/:symbol?range=` completa as três rotas. No CI, o `compose-smoke` só
consulta a cotação de PETR4; as três rotas são cobertas por
[`market.e2e.spec.ts`](apps/api/test/market/market.e2e.spec.ts). Cada
chamada bem-sucedida custa R$ 0,05 (`data_query`), inclusive quando a resposta vem do cache;
provedor fora (502) ou orçamento de chamadas ao provedor esgotado (503) não é cobrado. Por padrão (`MARKET_MODE=mock`) os preços vêm de uma tabela fixa: PETR4, VALE3, ITUB4,
BBDC4, BBAS3, MGLU3, WEGE3, PRIO3, HGLG11, KNRI11, MXRF11, XPML11, IVVB11 e BOVA11. Qualquer outro
ticker é `unknown_asset` na demo. Com `MARKET_MODE=live` as cotações vêm da brapi.dev
(`BRAPI_TOKEN` opcional) e os indicadores do BCB SGS; para conferir os provedores reais uma vez,
com rede, rode `pnpm build` e `pnpm --filter @carina/api market:smoke` (manual, fora do CI).

Com `LLM_MODE=live` e `OPENROUTER_API_KEY` os agentes usam os modelos de
[`apps/api/config/models.yaml`](apps/api/config/models.yaml). Os modos live de LLM e de mercado
**não são exercitados pelo CI**; leia [Limitações e segurança](#limitações-e-segurança) antes de ligá-lo.

## Importação de arquivos

O tenant (ou o investidor, pelo painel "Importar arquivo" da web) sobe um arquivo que já tem e os
dados entram na carteira sem custo de agregador: **OFX** (extrato bancário e de cartão), **CSV**
(com mapeamento de colunas ou preset) e **XLSX da Área do Investidor B3**. Escopo `data:write`
para enviar e `chat` para consultar. O upload responde 202 com um job; um worker faz o parse numa
thread isolada (limites de 30 s e 512 MB de heap, ajustável por `IMPORT_PARSE_MAX_HEAP_MB`), grava pelo mesmo caminho da ingestão (upsert idempotente,
`source: "import"`, cada lote de até 1.000 itens cobrado como `data_ingestion` de R$ 0,05) e o
progresso chega pelo WebSocket. Os bytes do arquivo saem do banco na mesma transação que fecha o
job.

```bash
APP="Authorization: Bearer sk-live-demoapp0000000000000000000000000"   # a chave da demo tem data:write
curl -s -X POST localhost:3000/api/clients/cliente-moderado/imports -H "$APP" \
  -F file=@extrato.ofx -F format=ofx                                    # → 202 {"id":…,"status":"queued"}
curl -s -X POST localhost:3000/api/clients/cliente-moderado/imports -H "$APP" \
  -F file=@extrato.csv -F format=csv -F csvPreset=nubank_conta \
  -F institution=Nubank -F account=conta-corrente
curl -s -X POST localhost:3000/api/clients/cliente-moderado/imports -H "$APP" \
  -F file=@posicao-b3.xlsx -F format=b3_xlsx -F asOf=2026-11-10         # data da fotografia
curl -s localhost:3000/api/clients/cliente-moderado/imports/<job.id> -H "$APP"   # status, contagens e erros por linha
```

`format` é opcional (detectado pelo conteúdo, nunca pela extensão; `format=csv` vale mesmo quando a
detecção não reconhece o CSV, que precisa usar `;` ou `,`). No CSV, `csvPreset`
(`nubank_conta` ou `generico_br`) ou `csvMapping` (JSON) é obrigatório, e `account` também. Limites:
10 MB por arquivo (413) e 5 importações ativas por cliente (429 com `Retry-After`). O mesmo arquivo
enviado de novo devolve o job existente (200, sem cobrar); um job `failed` é reenfileirado.

Limitações: os formatos foram **reconstruídos da documentação pública**, sem nenhum arquivo real
(as fixtures são sintéticas); a nota de corretagem em PDF (SINACOR) fica para a entrega 2; o extrato
de investimentos do OFX (`INVSTMTRS`) não é suportado; reenviar um job falho reprocessa o arquivo
(e cobra de novo os lotes regravados). Decisões, garantias e o restante das limitações estão em
[Importação de arquivos](docs/DECISOES-E-GARANTIAS.md#importação-de-arquivos-fase-2-entrega-1).

## Monitor de carteira

Com o pregão aberto, um job do worker cota os ativos das posições de investimento (cache de 60 s e
orçamento próprio de chamadas) e registra um alerta quando a variação do dia chega a
`MONITOR_MOVE_THRESHOLD_PCT` (padrão 5%): no máximo um por cliente, ativo, dia e sentido. É
determinístico, sem LLM e sem cobrança. O alerta é lido em `GET /api/clients/:clientId/alerts`
(escopo `chat`), chega ao vivo pelo WebSocket (`portfolio_alert`) e aparece no painel "Alertas da
carteira" da web. Não há notícias, volume anômalo nem canal externo (Fase 3); detalhes em
[ARQUITETURA](docs/ARCHITECTURE.md#15-monitor-de-carteira-monitor) e
[limitações](docs/DECISOES-E-GARANTIAS.md#limitações-do-monitor-de-carteira).

## Benchmark SEAL BR

Uma bateria de 42 perguntas sobre tributação, CVM, Open Finance, produtos e macro, portada do
Python, para medir um assistente financeiro. É determinística: a correção confere a presença de
fatos esperados na resposta (texto normalizado, sem acento e com vírgula decimal), reprova
afirmações proibidas e roda as checagens de compliance do Watchtower; não há LLM-judge. Escopo
`eval:run` (a chave app da demo tem):

```bash
curl -s "localhost:3000/api/eval/cases?category=tributacao" -H "$APP"          # catálogo, sem gabarito
curl -s -X POST localhost:3000/api/eval/submit -H "$APP" -H 'Content-Type: application/json' \
  -d '{"answers":{"acoes-isencao-20k":"É isento: vendas até R$ 20.000 por mês."}}'
# → {"answered":1,"passed":1,"passRate":1,...,"usage":{"workType":"evaluation","priceBrl":"5.00"}}
```

O catálogo é grátis. Cada submissão corrigida custa R$ 5,00 (`evaluation`), cobrada uma vez e só
depois de corrigir, e gasta 1 unidade da cota mensal do tenant (esgotada: 429 com `Retry-After`, sem
cobrança); entrada inválida (422: caso inexistente, id fora de `^[a-z0-9-]{1,64}$`, mais de 42
respostas, resposta com mais de 20 000 caracteres) não cobra nem gasta cota. O relatório traz, por
caso, só contagens (`factsTotal`, `factsMatched`, `forbiddenHits`), nunca o texto dos fatos
esperados: assim o benchmark não pode ser colhido submetendo respostas erradas (o Python devolvia
as descrições). Respostas e gabarito nunca vão para log. Não há tela na web nem histórico salvo;
detalhes em
[ARQUITETURA](docs/ARCHITECTURE.md#16-benchmark-seal-br-evaluation) e
[decisões](docs/DECISOES-E-GARANTIAS.md#benchmark-seal-br-fase-2-entrega-3).

## Estratégias e backtest

O `builder` guarda estratégias **declarativas** (nunca código do cliente) e roda um backtest
determinístico sobre o histórico diário do mercado. Duas estratégias: `buy_hold` e `sma_cross`
(média móvel rápida contra lenta). Escopo `builder:run` (a chave app da demo tem):

```bash
curl -s -X POST localhost:3000/api/builder/strategies -H "$APP" -H 'Content-Type: application/json' \
  -d '{"name":"Cruzamento 10/50","spec":{"kind":"sma_cross","symbol":"PETR4","fast":10,"slow":50}}'
# → 201 {"id":"<uuid>","name":"Cruzamento 10/50","spec":{...},"createdAt":"..."}
curl -s localhost:3000/api/builder/strategies -H "$APP"                       # as do tenant, mais novas primeiro
curl -s localhost:3000/api/builder/strategies/<uuid> -H "$APP"                # 404 se não for do tenant
curl -s -X POST "localhost:3000/api/builder/strategies/<uuid>/backtest?range=1y" -H "$APP"
# → {"symbol":"PETR4","kind":"sma_cross","bars":252,"totalReturnPct":...,"equityCurve":[...],
#    "usage":{"workType":"backtest","priceBrl":"7.50"}}
```

Criar, listar e ler são grátis. Cada backtest bem-sucedido custa R$ 7,50 (`backtest`) e gasta 1
unidade da cota mensal. A ordem é: `range` válido (`5d` a `5y`, padrão `1y`), estratégia do tenant
(404), histórico pelo `MarketService` (orçamento esgotado: 503 com `Retry-After`; provedor fora:
502), motor (histórico insuficiente ou fechamento menor ou igual a zero: 422) e só então a reserva
da cota (esgotada: 429 com `Retry-After`) e a cobrança. Qualquer erro anterior não reserva cota
nem cobra. Cada tenant guarda no máximo 100 estratégias (a 101ª é 422). O sinal do `sma_cross` é
exato e um empate entre as médias significa fora da posição. Limitações: só duas estratégias, sem
custos de transação nem slippage, sem edição ou remoção de estratégias e sem tela na web; detalhes em
[ARQUITETURA](docs/ARCHITECTURE.md#17-estratégias-e-backtest-builder) e
[decisões](docs/DECISOES-E-GARANTIAS.md#estratégias-e-backtest-fase-2-entrega-4).

## Arquitetura

```mermaid
flowchart LR
  web["Navegador<br/>apps/web (React + Vite)"]
  subgraph api["processo api"]
    rest["REST + WebSocket<br/>ApiKeyGuard, RateLimit, TenantContext"]
    graph["Orquestrador LangGraph.js<br/>classify → retrieve → especialistas → synthesize<br/>executor → approval (interrupt)"]
  end
  subgraph worker["processo worker"]
    jobs["Sync · ResumeWorker · Reconciliação · Monitor"]
  end
  pg[("PostgreSQL 17 + pgvector<br/>RLS FORCE · checkpoints do grafo")]
  redis[("Redis 7<br/>Streams · limites atômicos · tickets WS")]
  llm["LangChain.js<br/>OpenRouter → reservas → Groq<br/>(mock: determinístico)"]

  web -- "/api e /ws via nginx" --> rest --> graph
  graph --> llm
  graph --> pg
  rest -- "decisão → resume" --> redis
  redis --> jobs --> pg
  jobs -- "approval.executed" --> redis
  redis -- "inbox.events" --> rest
```

Uma ação irreversível segue este caminho: o executor propõe a ação e a proposta é validada; o
grafo grava a `approval_request` e para em `interrupt()`; uma chave com `inbox:decide` decide
(`SELECT … FOR UPDATE`); o `resume` vai ao Redis Streams depois do commit; o `ResumeWorker` retoma
o grafo, o nó `approval` relê o status no banco (o banco manda, não o evento) e `executeOnce`
grava `executed_action` com `INSERT … ON CONFLICT DO NOTHING`. Status, cobrança e auditoria
confirmam na mesma transação, e o painel recebe `approval_executed` pelo WebSocket do mesmo tenant
e cliente.

Os processos, os componentes e o fluxo detalhado estão em
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). As decisões, onde a implementação se afastou do
plano e os defeitos do Python que foram corrigidos estão em
[docs/DECISOES-E-GARANTIAS.md](docs/DECISOES-E-GARANTIAS.md). O desenho original está no
[spec da migração](docs/superpowers/specs/2026-11-11-migracao-typescript-design.md).

## Garantias provadas por testes

Os testes de integração e E2E rodam contra Postgres e Redis reais (no CI, `pgvector/pgvector:pg17`
e `redis:7-alpine`), conectados como `carina_app`, que é `NOSUPERUSER NOBYPASSRLS`. As principais:

- **Isolamento por RLS** entre tenants e entre clientes, com falha fechada fora de contexto:
  [`rls-isolation.int.spec.ts`](apps/api/test/database/rls-isolation.int.spec.ts).
- **Execução no máximo uma vez**, mesmo com `executeOnce` em paralelo, o mesmo `resume` entregue
  duas vezes ou por dois workers:
  [`inbox.int.spec.ts`](apps/api/test/inbox/inbox.int.spec.ts),
  [`resume.int.spec.ts`](apps/api/test/orchestrator/resume.int.spec.ts).
- **Ação desconhecida é irreversível** e exige aprovação:
  [`risk.spec.ts`](apps/api/src/modules/inbox/risk.spec.ts).
- **Cobrança e auditoria append-only**, e atômicas com o status da execução:
  [`migrations.int.spec.ts`](apps/api/test/database/migrations.int.spec.ts),
  [`billing.int.spec.ts`](apps/api/test/billing/billing.int.spec.ts).
- **Retomada entre tenants impossível** e eventos forjados não executam nada:
  [`orchestrator.int.spec.ts`](apps/api/test/orchestrator/orchestrator.int.spec.ts).
- **WebSocket**: ticket de uso único, e chave revogada ou tenant suspenso fecha o socket aberto:
  [`ws.e2e.spec.ts`](apps/api/test/chat/ws.e2e.spec.ts).
- **Limites atômicos** no Redis (50 reservas concorrentes com cota 10 → exatamente 10):
  [`limits.int.spec.ts`](apps/api/test/limits/limits.int.spec.ts).
- **Watchtower sem ReDoS**, com paridade com o Python:
  [`inspect-text.perf.spec.ts`](apps/api/src/modules/watchtower/inspect-text.perf.spec.ts).
- **O valor de um `place_trade` vem do servidor, não do modelo**: o executor cota o ativo
  (`MarketService.priceFor`), e um `valueBrl` incoerente do modelo não chega à aprovação nem à
  taxa (R$ 90,00 cobrados sobre R$ 3.000,00); sem cotação válida, nenhuma aprovação é criada:
  [`orchestrator.int.spec.ts`](apps/api/test/orchestrator/orchestrator.int.spec.ts) ("R-M7…"),
  [`trade-pricing.spec.ts`](apps/api/src/modules/agents/trade-pricing.spec.ts),
  [`market.service.spec.ts`](apps/api/src/modules/market/market.service.spec.ts).
- **Rotas de mercado** com escopo `market:read`, cobrança só após o sucesso e orçamento de
  chamadas ao provedor (cache negativo, 503 sem cobrança):
  [`market.e2e.spec.ts`](apps/api/test/market/market.e2e.spec.ts),
  [`market.service.spec.ts`](apps/api/src/modules/market/market.service.spec.ts).
- **Importação de arquivos**: os bytes saem do banco ao fechar o job (e a limpeza apaga os que
  sobrarem), `import_file` é isolada por RLS, nenhum conteúdo de linha chega a log, erro, auditoria
  ou evento, e reenviar o mesmo arquivo não duplica nem cobra de novo:
  [`imports.int.spec.ts`](apps/api/test/imports/imports.int.spec.ts) ("OFX de ponta a ponta…",
  "nenhum log, erro de linha, auditoria ou evento contém a descrição de uma transação da fixture"),
  [`imports.e2e.spec.ts`](apps/api/test/imports/imports.e2e.spec.ts) ("o mesmo arquivo de novo…"),
  [`rls-isolation.int.spec.ts`](apps/api/test/database/rls-isolation.int.spec.ts) ("tenant B não
  enxerga import_file de A…").
- **Benchmark SEAL BR**: catálogo e relatório sem gabarito (o relatório só traz contagens), escopo
  `eval:run`, cobrança de R$ 5,00 só depois de corrigir (422 não cobra), cota mensal (429 sem
  cobrança) e nenhuma resposta nos logs:
  [`evaluation.e2e.spec.ts`](apps/api/test/evaluation/evaluation.e2e.spec.ts),
  [`grading.spec.ts`](apps/api/src/modules/evaluation/grading.spec.ts).
- **Estratégias e backtest**: escopo `builder:run`, estratégia de outro tenant é 404, o backtest
  cobra R$ 7,50 uma vez e só no sucesso, e 404, 422, 502, 503 e 429 não cobram:
  [`builder.e2e.spec.ts`](apps/api/test/builder/builder.e2e.spec.ts),
  [`backtest.spec.ts`](apps/api/src/modules/builder/backtest.spec.ts).
- **Fluxo completo** pela fiação de produção:
  [`full-flow.e2e.spec.ts`](apps/api/test/flow/full-flow.e2e.spec.ts).

A tabela completa, com cada garantia e o nome do teste que a prova, está em
[Garantias provadas por testes](docs/DECISOES-E-GARANTIAS.md#garantias-provadas-por-testes).

## Como rodar os testes

Requisitos: Node 22.22.2 (`.nvmrc`) e pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm lint && pnpm typecheck
pnpm test                              # unidade: api, shared e web
pnpm --filter @carina/api test:int     # integração (Postgres + Redis reais)
pnpm --filter @carina/api test:e2e     # E2E da API (Supertest + WebSocket, LLM_MODE=mock)
pnpm --filter @carina/api test:cov     # unit + int + e2e com cobertura (limite: 80% de linhas em src/modules)
pnpm build
```

Integração e E2E precisam de Postgres com pgvector e Redis. Com Docker e sem nenhuma variável, o
harness sobe os dois via Testcontainers. Com serviços próprios (é o que o CI faz), aponte
`TEST_DATABASE_URL` (superusuário) e `TEST_REDIS_URL`. Os detalhes, incluindo
`TEST_DB_ICU_LOCALE`, estão em
[Como rodar os testes](docs/DECISOES-E-GARANTIAS.md#como-rodar-os-testes). O CI
([`ci.yml`](.github/workflows/ci.yml)) roda `typescript`, `compose-smoke` e `legacy-python`.

## Limitações e segurança

Esta é uma demo de portfólio, não um serviço pronto para produção. O que **não** está feito ou tem
limite conhecido:

- **Executores simulados.** Não há integração com corretora; a ordem é executada de mentira, ao
  preço de servidor.
- **O valor que define a taxa de execução ainda é afirmado pelo modelo em `transfer` e
  `rebalance`.** Ele é validado e conferido contra o payload quando possível, mas não há fonte de
  preço para eles. Em `place_trade` o preço vem do servidor (falha fechada: sem cotação fresca,
  não há aprovação), mas a taxa usa o valor que o aprovador viu, sem nova cotação na execução
  (vale até `APPROVAL_TTL_HOURS`), e não há calendário de feriados: um feriado parece pregão
  aberto e a cotação velha é recusada como `price_stale`.
- **Modo live de mercado sem teste no CI.** As fixtures de brapi.dev e BCB SGS foram reconstruídas
  da documentação (o sandbox de desenvolvimento não alcançava os provedores); rode
  `market:smoke` uma vez com rede para registrar respostas reais.
- **Live de mercado depende do plano da brapi.** Os padrões (1 ativo por requisição, 1 por vez)
  cabem no plano gratuito, mas `MARKET_QUOTE_MAX_AGE_MS` (5 min) precisa ser pelo menos o atraso
  do plano (~30 min no gratuito), senão toda ordem em pregão é recusada como `price_stale`; e um
  orçamento de 30 chamadas por minuto (rotas e preço, separados) protege, mas não confere, a cota
  mensal do token. Ver [Limitações conhecidas](docs/DECISOES-E-GARANTIAS.md#limitações-conhecidas-e-próximos-passos).
- **PII vai ao provedor de LLM no modo live**, e as conversas ficam nos checkpoints do LangGraph
  sem RLS, sem TTL e sem caminho de eliminação (LGPD). A auditoria guarda a pergunta mascarada
  por padrões e a resposta só como digest.
- **Benchmark SEAL BR sem LLM-judge, sem histórico e sem tela.** A correção só confere a presença
  de fatos (uma resposta certa com outras palavras reprova); as submissões não são guardadas; o
  dataset é estático (42 casos no código); não há tela na web.
- **Sem API administrativa** para suspender tenant ou revogar chave; a revogação vale em até 60 s.
- **Importação sem arquivo real.** OFX, CSV e a planilha da B3 foram reconstruídos da documentação
  pública; PDF SINACOR, `INVSTMTRS` e o resto estão em
  [Importação de arquivos](docs/DECISOES-E-GARANTIAS.md#importação-de-arquivos-fase-2-entrega-1).
- **Modo live sem teste automatizado**, Redis Streams sem `MAXLEN` e uma instância só exercitada.
- As chaves de demo são públicas, e o ticket do WebSocket vai na query string (vale 30 s e uma
  vez).

A lista completa, com os próximos passos de engenharia em ordem de prioridade, está em
[Segurança](docs/DECISOES-E-GARANTIAS.md#segurança-o-que-saber-antes-de-expor) e
[Limitações conhecidas](docs/DECISOES-E-GARANTIAS.md#limitações-conhecidas-e-próximos-passos).

## Roadmap

**Fase 2 — produtos B2B:** importação de arquivos (OFX, CSV e planilhas da Área do Investidor B3
já feitos; notas de corretagem em PDF na entrega 2), AOPs, `builder` e os agentes restantes.
Dos seis, quatro de chat (strategist, tax, researcher e assessor_liaison, até 3 por pergunta) e o
categorizer (regras determinísticas na ingestão, sem LLM) estão feitos. O researcher responde só com a
base de conhecimento (sem web) e o assessor_liaison só redige (nada é enviado). O monitor de carteira também
está feito (alerta pela API e pelo WebSocket, sem canal externo), e o `evaluation` (benchmark SEAL BR) e o `builder` (estratégias e backtest) também, só pela API.

**Fase 3 — integrações e remoção do Python:** notificações externas (WhatsApp, SMTP e webhook) para os alertas do monitor
e remoção de `legacy/python` e do job `legacy-python` do CI.
