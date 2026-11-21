# Design: monitor de carteira (agentes restantes, entrega 2)

Data: 2026-11-21. Origem: roadmap da Fase 2 (agente `monitor`) e o spec dos agentes restantes, que
deixou o monitor para esta entrega por falta de canal de alerta. O usuário delegou as escolhas
("pode começar, escolha você"); tudo abaixo é decisão nossa.

## 1. Intenção

Avisar quando um ativo da carteira de um cliente tiver um movimento forte no dia, sem depender de
alguém perguntar no chat. O aviso precisa chegar a quem consome o CARINA: o cliente B2B (pela API) e
a pessoa com a web aberta (em tempo real), e ficar guardado para quem não estava olhando.

No Python o monitor nunca vigiou nada (o job do Modal só mantinha o FalkorDB acordado; a vigilância
era um `TODO`). Aqui ele nasce de verdade, como job determinístico.

## 2. Escopo

Entra:
- job periódico no worker que, com o pregão aberto, cota os ativos das posições de investimento e
  registra um alerta quando a variação do dia passa do limite;
- tabela `portfolio_alert` sob RLS, com um alerta por cliente, ativo, dia e sentido;
- evento em tempo real no WebSocket do chat (`portfolio_alert`);
- `GET /api/clients/:clientId/alerts` (lista paginada) para o cliente B2B;
- painel "Alertas da carteira" na web.

Fora (não-objetivos): notícias (o provedor não tem), volume anômalo (exige média histórica, que
custa cota), WhatsApp/e-mail/webhook (Fase 3, notificações), LLM ou texto gerado, recomendação de
ação, configuração de limite por cliente, cobrança.

Anti-objetivos (falha mesmo que "funcione"):
- estourar a cota do provedor de cotações ou tirar orçamento do preço das ordens e das rotas;
- repetir o mesmo alerta a cada ciclo (spam);
- alerta com dado velho (cotação de outro modo, de mercado fechado ou fora do cache válido);
- vazar posição ou alerta de um tenant/cliente para outro;
- qualquer texto que soe como recomendação de compra ou venda.

## 3. Abordagem

Consideradas:
1. **Job determinístico no worker, alerta guardado e publicado** (escolhida). Reaproveita o padrão
   de job com lock (`ImportCleanupJob`/`ReconciliationJob`), o `MarketService` com cache e
   orçamento, o stream `inbox.events` e o `InboxBroadcast`.
2. Agente LLM que "lê" a carteira e escreve o alerta: descartado. Custo por ciclo, texto não
   determinístico, risco de soar como recomendação, e não acrescenta nada a uma regra de variação.
3. Calcular sob demanda (quando alguém abre a web ou chama a API): descartado. Não avisa ninguém, que
   é o objetivo.

## 4. Desenho

### 4.1 Ciclo (`MonitorJob`, módulo `apps/api/src/modules/monitor/`)

- `setInterval` unref de `MONITOR_INTERVAL_MS` (env, padrão 600 000 = 10 min, mínimo 60 000), só
  com `WORKERS_ENABLED !== "false"`; parada esperando o ciclo em andamento (como o `ImportCleanupJob`).
- Lock global no Redis `monitor:tick` por ciclo (outra réplica → ciclo pulado).
- Só roda com `marketStateAt(clock.now()) === "open"` (`market-hours.ts`); fora do pregão, ciclo vazio.
- Tenants: função `monitor_tenant_ids()` (SECURITY DEFINER, padrão da `import_cleanup_tenant_ids`)
  que devolve os tenants com posição `kind = 'investment'` e `asset_code` não nulo, sem tenant
  suspenso. Cada tenant sob `TenantContext.run` (RLS): lê `(client_id, asset_code)` distintos.
- Símbolos: união de todos os tenants, ordenada, limitada a `MONITOR_MAX_SYMBOLS_PER_TICK` (env,
  padrão 10) por ciclo, em rodízio: um cursor no Redis (`monitor:cursor`) guarda onde parou, para
  que carteiras grandes sejam cobertas ao longo dos ciclos. O limite por ciclo não deve passar do
  orçamento do monitor × símbolos por chamada (`MARKET_MONITOR_MAX_CALLS_PER_MIN` ×
  `MARKET_BRAPI_MAX_SYMBOLS_PER_CALL`), senão o ciclo termina esgotado.
- Cotações por `MarketService.monitorQuotes(symbols)`: usa o cache de 60 s e um **terceiro
  orçamento** `market:<modo>:budget:monitor:<minuto>` com `MARKET_MONITOR_MAX_CALLS_PER_MIN` (env,
  padrão 10), separado das rotas e do preço. Orçamento esgotado → para de cotar neste ciclo, sem
  erro (o rodízio retoma no próximo). Redis fora → ciclo pulado (o lock já depende dele).
- Uma falha num tenant é logada (só ids) e não impede os demais.

### 4.2 Regra

Alerta quando `|changePct| ≥ MONITOR_MOVE_THRESHOLD_PCT` (env, padrão 5, entre 1 e 50), com a
cotação `marketState === "open"`, `source` do modo atual e `changePct` não nulo. Sentido `up` ou
`down`. Função pura `detectMove(quote, thresholdPct)`, testável sozinha.

### 4.3 Dado

`portfolio_alert`: `id uuid`, `tenant_id`, `client_id` (FK composta com cascade, como as demais),
`asset_code text`, `direction text CHECK (up|down)`, `change_pct numeric(9,4)`, `price numeric(18,6)`,
`trading_day date` (data de São Paulo), `created_at timestamptz`. Único
`(tenant_id, client_id, asset_code, trading_day, direction)`: um alerta por dia e sentido; o insert
é `ON CONFLICT DO NOTHING RETURNING` e só o que foi inserido é publicado. RLS com FORCE, política por
tenant como as outras tabelas. Índice `(tenant_id, client_id, created_at DESC, id DESC)`.

### 4.4 Entrega

- Stream: `monitor.alert` em `inbox.events` com `{ tenantId, clientId (interno), alert }`.
- `InboxBroadcast`: como os eventos de importação, não lê o banco; vira `ChatEvent`
  `{ type: "portfolio_alert", alert }` só para os assinantes da chave `(tenantId, clientId)`.
- API: `GET /api/clients/:clientId/alerts?cursor=&limit=` (escopo `chat`, `:clientId` = externalId
  como nas outras rotas), mais novo primeiro, cursor opaco, `limit` 1..50 (padrão 20). Sem cobrança.
- Contrato compartilhado: `PortfolioAlertSchema` `{ id, assetCode, direction, changePct (string
  decimal), price (string decimal), tradingDay, createdAt }`.
- Web: painel "Alertas da carteira" com a lista (busca na API ao abrir) e os novos alertas chegando
  pelo WebSocket no topo. Texto fixo e neutro: "PETR4 caiu 6,2% hoje (R$ 31,40)." e, no rodapé,
  "Variação do dia em relação ao fechamento anterior. Não é recomendação de investimento."

### 4.5 LGPD e logs

Logs só com ids e contagens (tenants, símbolos, alertas). Nenhum valor de posição sai do banco; o
alerta guarda só ativo, variação e preço público.

## 5. Testes e aceite

- Unitários: `detectMove` (limite exato, negativo, nulo, mercado fechado, source de outro modo);
  rodízio do cursor; orçamento do monitor esgotado para o ciclo sem erro; ciclo fora do pregão não
  cota; lock pulado.
- Integração (Postgres + Redis): ciclo com posições de dois tenants e cotações do mock forjadas →
  alertas gravados sob o tenant certo, um por dia e sentido (segundo ciclo não duplica), evento
  `monitor.alert` publicado só para o inserido; RLS: tenant B não lê alerta de A; cascade ao apagar
  cliente.
- E2E: `GET /alerts` paginado, 404 para cliente de outro tenant, escopo errado → 403; WebSocket
  recebe `portfolio_alert` só do próprio cliente.
- Web: painel lista, recebe ao vivo, mostra o aviso fixo.
- Docs: README, ARCHITECTURE, DECISOES (decisões desta seção e limitações: sem notícias, sem volume,
  sem canal externo, limite único por instância).

## 6. O que fica com quem implementa

Nomes internos, formato do cursor, layout do painel no estilo dos existentes, e como forçar
variação no provedor mock nos testes (injeção do provedor ou fixture), desde que o modo mock de
demo continue determinístico.
