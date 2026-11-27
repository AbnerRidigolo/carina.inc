# Design: AOPs (Agent Operating Procedures)

Data: 2026-11-25. Origem: roadmap da Fase 2, `docs/B2B.md` (Modo 2 de integração) e
`legacy/python/carina/b2b/aops.py` (com `modal_jobs/aops_job.py`, `tests/test_b2b_aops.py` e as rotas
`/aops*` em `carina/api/routes.py`). O usuário mandou seguir; as escolhas que não estão no Python são
nossas e estão marcadas.

## 1. Intenção

O tenant B2B descreve em linguagem natural um procedimento recorrente — "toda sexta às 9h, analise a
carteira e o risco dos clientes premium" — e o CARINA o compila numa automação: quais agentes rodar,
em que agenda, para quais clientes. Um job no worker executa o que venceu; cada execução por cliente
é uma resolução cobrada e auditada pelo Watchtower, como uma conversa no chat. O tenant liga, desliga,
dispara na hora e lê o resultado de cada execução pela API.

## 2. Escopo

Entra: criar por texto (compilação por LLM `reasoning` com saída estruturada e contingência
heurística — o padrão do classificador do chat); listar, ler, ligar/desligar; disparar na hora;
execução agendada no worker; histórico de execuções por AOP.

Fora: editar texto/agentes/agenda depois de criado (cria-se outro), remover, Executor (ação
irreversível nunca roda por AOP), entrega das execuções por WhatsApp/e-mail/webhook (Fase 3), tela na
web, AOP que acione o monitor (o monitor já é um job próprio).

Anti-objetivos:
- um AOP que dispara duas vezes para o mesmo horário (réplicas, reinício, retry);
- AOP acionar o Executor ou qualquer ação irreversível;
- execução de um tenant tocar cliente de outro;
- cobrar sem executar, ou executar sem cobrar e sem respeitar a cota mensal;
- um AOP com muitos clientes travar o worker ou estourar o custo sem limite;
- texto do tenant (descrição) virar instrução para os agentes além do que já é: é DADO, como a
  pergunta do chat.

## 3. Abordagem

Porte com persistência em Postgres sob RLS e execução assíncrona no worker (escolhida). Alternativas
descartadas: execução síncrona na rota `run` como no Python (N clientes × agentes LLM estoura o tempo
de uma requisição); compilar só por heurística (perde o "linguagem natural" que é o produto).

## 4. Desenho

### 4.1 Modelo
- `AopSchema` (shared): `id`, `name` (1..120), `description` (1..2000, o texto original), `agents`
  (1..3 dentre `insight`, `predictor`, `risk`, `strategist`, `tax`, `researcher`, `assessor_liaison`;
  ordem fixa do chat, mesmo `MAX_SPECIALISTS = 3`), `schedule`, `clientIds` (1..20 externalIds),
  `enabled`, `createdAt`, `lastFireAt`. Ao criar, `lastFireAt = previousFire(agenda, agora)` e, ao
  religar, nunca recua (`GREATEST`): o primeiro disparo é o PRÓXIMO horário (decisão da revisão final;
  o Python disparava no primeiro ciclo). Para rodar já, usa-se o disparo manual.
- `ScheduleSchema`: `frequency` (`daily|weekly|monthly`), `weekday` (0=segunda…6=domingo), `day`
  (1..28), `hour` (0..23). **Hora em `America/Sao_Paulo`** (decisão nossa; o Python usava UTC — o
  cliente pensa no horário de Brasília e o Brasil não tem horário de verão). Padrão: semanal, sexta,
  9h (o "11h UTC" do Python).
- Funções puras: `previousFire(schedule, now)` e `isDue(schedule, now, lastFireAt)`, com a mesma
  lógica do Python, calculadas no fuso de São Paulo.

### 4.2 Compilação
- `AopCompiler.compile(text)`: modelo `reasoning` com schema Zod (mockKey `aop_compiler`) →
  normalizado (agentes fora da lista descartados; `tax_optimizer`/`rebalancer` do Python mapeados para
  `tax`/`risk`; dedupe; ordem fixa; corte em 3; agenda validada); qualquer falha → heurística por
  palavras-chave portada do Python (reaproveitando as palavras e limites de palavra da heurística do
  chat onde coincidirem). A descrição vai como mensagem `human` isolada, nunca no system prompt.
- Nenhum agente identificado → 422 com a lista de agentes disponíveis.

### 4.3 Dado (migração 0011)
- `aop`: colunas do modelo + `tenant_id`; RLS FORCE por tenant; limite de **50** AOPs por tenant
  (advisory lock, como o builder).
- `aop_run`: `id`, `tenant_id`, `aop_id` (FK com cascade), `client_id` (uuid interno, FK com cascade),
  `fire_at` (o horário agendado ou o instante do disparo manual), `trigger` (`schedule|manual`),
  `status` (`ok|failed|skipped`), `failure_code` (`client_not_found|quota_exceeded|agents_failed`),
  `results` jsonb (por agente, saída validada ou `{failed:true}`, cortada como no chat), `work_type`,
  `price_brl`, `audit_id`, `created_at`; RLS FORCE por tenant; único `(aop_id, client_id, fire_at)`.
- Função SECURITY DEFINER `aop_tenant_ids()` (padrão da `monitor_tenant_ids`): tenants com AOP
  habilitado, sem tenant suspenso.

### 4.4 Execução
- **Disparo idempotente:** antes de rodar, `UPDATE aop SET last_fire_at = $fire WHERE id = $id AND
  enabled AND (last_fire_at IS NULL OR last_fire_at < $fire) RETURNING` — só quem ganha roda; o
  único de `aop_run` cobre o resto (réplica concorrente, reentrega).
- **`AopJob`** (worker, padrão do `MonitorJob`): a cada `AOP_TICK_MS` (padrão 300 000, mínimo
  60 000), lock `aops:tick`, tenants por `aop_tenant_ids()`, AOPs vencidos sob RLS, disparo
  idempotente, execução. Um AOP/tenant que falha não derruba os outros.
- **Manual:** `POST /api/aops/:id/run` grava o disparo (`trigger: manual`, `fire_at = now`) e publica
  `aop.run_requested` no stream `jobs`; responde **202** com o `fireAt`. O worker consome (grupo
  `aops`) e executa. No máximo 1 disparo manual por AOP por minuto (409 `manual_run_too_soon` com `Retry-After`;
  AOP desligado → 409 `aop_disabled`). O `fireAt` manual guarda milissegundos e nunca cai em `.000` de
  um minuto cheio, para não coincidir com um horário agendado; o disparo manual NÃO altera `last_fire_at`.
- **Por cliente** (sequencial dentro do AOP; teto de 20 clientes): resolve o externalId sob o tenant
  (sumiu → `skipped/client_not_found`, sem cobrança); reserva a cota mensal (esgotada →
  `skipped/quota_exceeded` para este e os seguintes, sem cobrança); busca conhecimento do cliente
  (`KnowledgeService.search(description)`); roda os agentes em paralelo pelo `AgentRegistry`
  (`run({ question: "Execute o procedimento: …", history: [], knowledge })`), falha de um vira
  `{failed:true}`; se TODOS falharem → `failed/agents_failed`, estorna a cota, não cobra; senão cobra
  `classifyWork(agents)` com o `clientId`, revisa no Watchtower (canal `worker`, query
  `[AOP:<nome>] <descrição>`, resposta = resultados serializados) e grava o `aop_run`.

### 4.5 Rotas (escopo novo `aops:manage`; o seed o dá à chave de demo com `data:write`)
- `POST /api/aops` `{ description, clientIds, name? }` → 201 (compila; sem cobrança).
- `GET /api/aops`, `GET /api/aops/:id` (404 entre tenants).
- `PATCH /api/aops/:id` `{ enabled }`.
- `POST /api/aops/:id/run` → 202.
- `GET /api/aops/:id/runs?cursor=&limit=` (mais novos primeiro; `limit` 1..50).
- Logs e auditoria só com ids, agentes e contagens; a descrição só vai ao Watchtower, como a pergunta
  do chat.

## 5. Testes e aceite

Paridade com `test_b2b_aops.py`: agenda diária/semanal/mensal vencida; heurística extrai agentes e
agenda; diária e mensal; criar compila e persiste; sem agentes → erro; execução mede e audita; agenda
respeitada; desabilitado não roda; API cria, lista, roda e isola por tenant; sem agentes → 422; sem
chave → 401. Mais: `previousFire` com tabela gerada rodando o Python (convertendo UTC↔São Paulo);
compilador LLM normaliza (agente inválido, executor, mais de 3, agenda fora da faixa) e cai na
heurística; disparo idempotente sob concorrência (dois workers, um roda); cota esgotada no meio;
cliente removido; todos os agentes falham → sem cobrança; manual → 202 e o worker executa; 409 no
segundo manual no mesmo minuto; RLS de `aop` e `aop_run`; limite de 50.

## 6. O que fica com quem implementa

Textos do prompt do compilador, formato do cursor, como forçar o relógio e os agentes nos testes.
