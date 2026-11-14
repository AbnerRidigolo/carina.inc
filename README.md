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
`redis` → `migrate` → `seed` → `api` → `web`; o `worker` (sync, retomada de aprovações e
reconciliação) sobe depois do `migrate`.

Se você já tinha subido a demo antes de o tenant de demo ganhar id fixo, apague os volumes antigos
com `docker compose down -v` antes de subir de novo. Sem isso, o seed falha com
"DEMO_APP_KEY já pertence a outro tenant".

O seed cria o tenant `demo`, três clientes sintéticos já sincronizados com a base de conhecimento
(`cliente-conservador`, `cliente-moderado` e `cliente-arrojado`) e duas chaves:

| Variável            | Valor padrão                               | Escopos                 |
| ------------------- | ------------------------------------------ | ----------------------- |
| `DEMO_APP_KEY`      | `sk-live-demoapp0000000000000000000000000` | `chat`, `data:write`    |
| `DEMO_APPROVER_KEY` | `sk-live-demoapprover00000000000000000000` | `chat`, `inbox:decide`  |

> **Essas chaves são públicas (estão neste repositório) e servem só para a demo local.** Com
> `NODE_ENV=production` o seed recusa as chaves fixas, a menos que `SEED_ALLOW_DEMO_KEYS=true`.
> Só o compose de demo liga essa opção. Fora da demo, defina `DEMO_APP_KEY` e
> `DEMO_APPROVER_KEY` com chaves novas. Todas as variáveis estão em [.env.example](.env.example).

### Roteiro de 2 minutos

1. Conecte com a `DEMO_APPROVER_KEY` e pergunte "Como está minha carteira?". O Insight roda e o
   Navigator responde em streaming, com o custo do turno.
2. Peça "compre 100 ações de PETR4". O executor propõe a ordem (R$ 3.000,00 no preço fixo do mock),
   o grafo pausa e a aprovação aparece no painel.
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

Com `LLM_MODE=live` e `OPENROUTER_API_KEY` os agentes usam os modelos de
[`apps/api/config/models.yaml`](apps/api/config/models.yaml). O modo live **não é exercitado pelo
CI**; leia [Limitações e segurança](#limitações-e-segurança) antes de ligá-lo.

## Arquitetura

```mermaid
flowchart LR
  web["Navegador<br/>apps/web (React + Vite)"]
  subgraph api["processo api"]
    rest["REST + WebSocket<br/>ApiKeyGuard, RateLimit, TenantContext"]
    graph["Orquestrador LangGraph.js<br/>classify → retrieve → especialistas → synthesize<br/>executor → approval (interrupt)"]
  end
  subgraph worker["processo worker"]
    jobs["Sync · ResumeWorker · Reconciliação"]
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

- **Executores simulados.** Não há integração com corretora; o preço do `place_trade` no mock é
  fixo.
- **O valor que define a taxa de execução é afirmado pelo modelo.** Ele é validado e conferido
  contra o payload quando possível, mas não há fonte de preço no servidor.
- **PII vai ao provedor de LLM no modo live**, e as conversas ficam nos checkpoints do LangGraph
  sem RLS, sem TTL e sem caminho de eliminação (LGPD). A auditoria guarda a pergunta mascarada
  por padrões e a resposta só como digest.
- **Sem API administrativa** para suspender tenant ou revogar chave; a revogação vale em até 60 s.
- **Modo live sem teste automatizado**, Redis Streams sem `MAXLEN` e uma instância só exercitada.
- As chaves de demo são públicas, e o ticket do WebSocket vai na query string (vale 30 s e uma
  vez).

A lista completa, com os próximos passos de engenharia em ordem de prioridade, está em
[Segurança](docs/DECISOES-E-GARANTIAS.md#segurança-o-que-saber-antes-de-expor) e
[Limitações conhecidas](docs/DECISOES-E-GARANTIAS.md#limitações-conhecidas-e-próximos-passos).

## Roadmap

**Fase 2 — produtos B2B:** importação de arquivos (OFX, CSV, planilhas da Área do Investidor B3,
notas de corretagem), AOPs, `market`, `evaluation`, `builder` e os seis agentes restantes
(strategist, researcher, assessor_liaison, monitor, categorizer e tax).

**Fase 3 — integrações e remoção do Python:** notificações (WhatsApp e SMTP), monitor de carteiras
e remoção de `legacy/python` e do job `legacy-python` do CI.
