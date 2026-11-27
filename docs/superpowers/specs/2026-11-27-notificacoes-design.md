# Design: notificações externas, entrega 1 (webhook e e-mail)

Data: 2026-11-27. Origem: roadmap da Fase 3 ("notificações externas (WhatsApp, SMTP e webhook) para os
alertas do monitor"), `legacy/python/carina/integrations/notify.py` (com `tests/test_notify.py`) e o
stream `notifications`, que já existe sem consumidor. O usuário escolheu "avisar o tenant" e a entrega 1
(webhook e e-mail); o WhatsApp fica na entrega 2. As demais escolhas foram delegadas e estão marcadas
como nossas.

## 1. Intenção

Hoje o alerta do monitor, o resultado dos AOPs e a ação reversível executada só chegam por quem
consulta a API ou mantém um WebSocket aberto. O tenant B2B (corretora, assessoria) precisa ser avisado
sem ficar consultando: num sistema dele (webhook) ou na caixa de e-mail da equipe. Quem recebe é o
**tenant**, nunca o cliente final: o tenant decide o que repassar ao investidor. Assim o CARINA não
guarda e-mail nem telefone de investidor (LGPD) e não fala de investimento direto com o cliente final.

## 2. Escopo

Entra:
- destinos por tenant: `webhook` (URL https + segredo HMAC) e `email` (1..5 endereços);
- assinatura por tipo de evento: `monitor.alert`, `aop.finished` e `action.executed`;
- entrega assíncrona no worker, com novas tentativas e histórico por destino;
- disparo de teste (`ping`) para validar um destino;
- modo `mock` dos canais para dev e testes, como o `LLM_MODE` e o `MARKET_MODE`.

Fora: WhatsApp (entrega 2), contato do cliente final, tela na web, templates de e-mail configuráveis
pelo tenant, HTML no e-mail, reenvio manual de uma entrega que falhou, eventos além dos três.

Anti-objetivos:
- notificação derrubar ou atrasar a ação, o alerta ou o AOP que a originou;
- entregar evento de um tenant no destino de outro;
- webhook virar SSRF (endereço interno, metadados de nuvem, redirecionamento para dentro);
- conteúdo sensível sair do servidor: descrição do AOP, pergunta do chat, resultado dos agentes,
  gabarito; o payload leva só ids, códigos, símbolos e números;
- segredo do webhook legível depois de criado (nem pela API, nem em log);
- a mesma entrega enviada duas vezes por corrida entre workers (reenvio por falha é permitido e o
  receptor deduplica pelo `eventId`);
- um destino lento ou fora do ar travar a fila dos outros.

## 3. Abordagens

- **Tenant como destinatário, stream + tabela de entregas (escolhida).** Os produtores publicam um
  evento `notification` no stream `notifications` depois do COMMIT, em melhor esforço, como já fazem
  com o `inbox.events`. Um consumidor (grupo `notify`, com reentrega e DLQ do `StreamsService`)
  transforma cada evento em uma linha por destino assinante, de forma idempotente. Um job do worker
  envia as linhas pendentes. Uniforme para os três produtores e aproveita o contrato que já existe.
- **Outbox na mesma transação do produtor.** Mais forte (nenhuma perda entre COMMIT e publicação), mas
  mexe na transação do monitor e dos AOPs e não serve à ação reversível do grafo, que não roda numa
  transação. A perda possível na escolhida é a mesma do WebSocket de hoje; descartada.
- **Cliente final como destinatário** (e-mail/telefone por cliente) e **porte literal do Python**
  (contato dentro de cada evento): descartadas na conversa (LGPD e conformidade; e o monitor e os AOPs
  não têm de onde tirar o contato).

## 4. Desenho

### 4.1 Evento no stream
O `notification` de `StreamEventSchema` (hoje `kind` + `text` livres, só usado pela ação reversível)
vira estruturado: `kind` ∈ `monitor.alert | aop.finished | action.executed` e `data` validado por
`kind` (união discriminada). `clientId` do `streamBase` é o uuid interno; vazio para `aop.finished`
(o AOP é do tenant, como em `aop.run_requested`).

- `monitor.alert`: `data = { alert: PortfolioAlert }`. Publicado pelo `MonitorJob` junto do
  `monitor.alert` de `inbox.events`, depois do COMMIT.
- `aop.finished`: `data = { aopId, fireAt, trigger, ok, failed, skipped }` (contagens do
  `AopRunSummary`). Publicado pelo job/consumidor dos AOPs ao fim de cada disparo que gravou ao menos
  uma linha em `aop_run` (sem publicação quando tudo foi `already_ran`).
- `action.executed`: `data = { action }`, onde `action` é só o NOME da ação (string da lista fixa de
  ações reversíveis), sem `payload`, `valueBrl` nem `rationale` da proposta (texto e dados escolhidos
  pelos agentes). Decisão nossa. A publicação que já existe em `graph.ts` passa ao formato novo.

O evento ganha `occurredAt` (ISO), porque o `streamBase` não tem horário. Eventos no formato antigo
(`kind` + `text`) que já estejam no stream são descartados pelo consumidor com log, sem DLQ; o grupo
`notify` é criado a partir do fim do stream (`$`), sem reprocessar o histórico. Decisão nossa.

### 4.2 Payload entregue
Igual nos dois canais (o e-mail o formata em texto):
`{ eventId, type, occurredAt, clientExternalId: string | null, data }`. **Sem `tenantId`**
(o destino já é do tenant) e **com `clientExternalId`** no lugar do uuid interno: o tenant conhece os
seus `externalId`s, não os nossos uuids. O consumidor resolve o `externalId` sob RLS; cliente que sumiu
→ evento descartado com log (só ids). `data` é copiado do evento sem acrescentar nada.

### 4.3 Dado (migração 0012)
- `notification_destination`: `id`, `tenant_id`, `kind` (`webhook|email`), `name` (1..120),
  `url` (webhook), `secret_ciphertext` (webhook, AES-256-GCM), `emails text[]` (email, 1..5),
  `events text[]` (1..3, dentre os três tipos), `enabled`, `created_at`. CHECKs espelhando o schema
  (webhook tem url e segredo e não tem emails; email o contrário). RLS ENABLE + FORCE por tenant.
  Limite de **10** destinos por tenant (advisory lock, como o builder). Decisão nossa.
- `notification_delivery`: `id`, `tenant_id`, `destination_id` (FK cascade), `event_id`, `event_type`,
  `payload jsonb`, `status` (`pending|sent|failed`), `attempts`, `next_attempt_at`, `last_error`
  (código fixo: `timeout|network|http_4xx|http_5xx|blocked_address|smtp_error|config_missing|
  destination_disabled|expired`),
  `last_status_code`, `sent_at`, `created_at`. Único `(destination_id, event_id)`. RLS FORCE por
  tenant. Índice parcial em `(next_attempt_at) WHERE status = 'pending'`.
- Função SECURITY DEFINER `notification_due_tenant_ids()` (padrão de `aop_tenant_ids()`): tenants com
  entrega `pending` vencida, sem tenant suspenso.
- Remover um destino apaga as suas entregas (cascade). Entregas com mais de **30 dias** são apagadas
  pelo job (decisão nossa).

### 4.4 Segredo do webhook
- Gerado pelo servidor (32 bytes aleatórios, `whsec_` + base64url) e devolvido **uma única vez** na
  resposta do POST. Guardado cifrado com AES-256-GCM sob `NOTIFICATIONS_ENCRYPTION_KEY` (32 bytes em
  base64; obrigatória com `NODE_ENV=production`; fora de produção, uma chave fixa de dev). Nenhuma rota
  devolve o segredo depois; `POST /:id/rotate-secret` gera outro e o devolve uma vez.
- Assinatura de cada envio: `X-Carina-Timestamp: <unix s>` e
  `X-Carina-Signature: v1=<hex(HMAC-SHA256(segredo, "<timestamp>.<corpo>"))>`, mais
  `X-Carina-Event-Id`. A documentação explica a verificação e a janela de 5 minutos sugerida ao
  receptor.

### 4.5 Proteção contra SSRF (webhook)
- URL: `https:` obrigatório (fora de produção, `http:` também, para testes locais); sem credenciais na
  URL; até 2048 caracteres.
- Endereço: o host é resolvido e **todo** endereço resolvido precisa ser público. Recusados: loopback,
  privados (10/8, 172.16/12, 192.168/16), link-local (169.254/16, inclui metadados de nuvem), CGNAT
  (100.64/10), multicast, não especificado, 0/8, faixas de documentação e reservadas; em IPv6, `::1`,
  `fc00::/7`, `fe80::/10`, `::ffff:` mapeando os anteriores. Checado ao criar (422) e **a cada envio**,
  com o IP fixado na conexão (o `lookup` da requisição devolve o endereço já validado, sem nova
  resolução entre a checagem e o connect: sem DNS rebinding). Falha no envio → `blocked_address`, sem
  nova tentativa.
- Sem seguir redirecionamento (3xx conta como `http_4xx`, sem nova tentativa). Timeout de 10 s.
  Corpo da resposta ignorado (lido e descartado até 64 KB).
- `NOTIFY_ALLOW_PRIVATE_NETWORKS=true` libera os endereços internos **só fora de produção** (testes
  e2e com receptor local); com `NODE_ENV=production`, a configuração é recusada no boot.

### 4.6 E-mail
- SMTP via `nodemailer` (dependência nova): `SMTP_HOST`, `SMTP_PORT` (padrão 587), `SMTP_SECURE`
  (padrão `false`, STARTTLS exigido quando há usuário), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
  (obrigatório quando há `SMTP_HOST`). Como no Python, `SMTP_HOST` ausente → entrega `failed` com
  `config_missing`, sem novas tentativas.
- Texto puro em português, um modelo por tipo, com assunto `CARINA — <resumo>` e o mesmo conteúdo do
  payload (ids, símbolo, variação, contagens). Uma mensagem por destino, com todos os endereços em
  `To`.

### 4.7 Entrega
- **Enfileirar** (consumidor do stream `notifications`, grupo `notify`): tenant suspenso → nada é
  enfileirado (evento descartado com log). Senão, sob o tenant do evento, lista
  destinos `enabled` cujo `events` contém o `kind`, resolve `clientExternalId` e insere uma
  `notification_delivery` por destino (`ON CONFLICT DO NOTHING` no único: reentrega do stream não
  duplica). `next_attempt_at = now()`.
- **Enviar** (`NotificationJob` no worker, padrão do `MonitorJob`/`AopJob`): a cada `NOTIFY_TICK_MS`
  (padrão 10 000, mínimo 1 000), lock `notify:tick`; tenants por `notification_due_tenant_ids()`; por
  tenant, reivindica até 20 vencidas com `FOR UPDATE SKIP LOCKED`, grava `attempts + 1` e
  `next_attempt_at = now() + 2 min` (prazo de posse: se o worker morrer, outra volta pega) e faz
  COMMIT antes de enviar; envia com concorrência limitada (5); grava o resultado. Teto de 100 envios por
  volta.
- **Resultado:** 2xx (ou SMTP aceito) → `sent`. Erro retentável (timeout, rede, 5xx, 408, 429, SMTP
  transitório) → `pending` com espera de 1 min, 5 min, 30 min e 2 h; na 5ª tentativa → `failed`. Erro
  definitivo (outro 4xx, 3xx, `blocked_address`, `config_missing`, SMTP permanente 5xx) → `failed`.
- **Validade:** entrega ainda `pending` 24 h depois de criada vira `failed` com `expired` em vez de ser
  enviada (a escada de esperas soma menos de 3 h; isso só acontece com tenant suspenso e depois
  reativado, e evita despejar alertas velhos). Decisão nossa.
- Destino desligado ou removido depois de enfileirar: a entrega pendente vira `failed` com
  `destination_disabled` (desligado) ou some (removido, cascade).
- `NOTIFY_MODE` (`live|mock`; padrão `mock` fora de produção, obrigatório em produção): no `mock`, os
  canais não abrem conexão e registram o envio num coletor em memória que os testes leem.

### 4.8 Rotas (escopo novo `notifications:manage`; o seed o dá à chave de demo com `data:write`)
- `POST /api/notifications/destinations` `{ kind, name, url? , emails?, events }` → 201 com o destino
  e, se webhook, o `secret` (única vez).
- `GET /api/notifications/destinations`, `GET /api/notifications/destinations/:id` (404 entre
  tenants; nunca devolvem segredo; e-mails e URL devolvidos, são do tenant).
- `PATCH /api/notifications/destinations/:id` `{ enabled?, events?, name? }` (URL e e-mails não mudam:
  cria-se outro destino, como no AOP).
- `DELETE /api/notifications/destinations/:id` → 204.
- `POST /api/notifications/destinations/:id/rotate-secret` → 200 com o novo `secret` (só webhook).
- `POST /api/notifications/destinations/:id/test` → 202; grava direto uma entrega `ping`
  (`data = {}`, sem passar pelo stream) só para esse destino, mesmo que não o assine. No máximo 1 por destino por minuto
  (409 `test_too_soon` com `Retry-After`).
- `GET /api/notifications/deliveries?destinationId=&status=&cursor=&limit=` (mais novas primeiro;
  `limit` 1..50): `id`, `destinationId`, `eventId`, `eventType`, `status`, `attempts`, `lastError`,
  `lastStatusCode`, `createdAt`, `sentAt`. Sem o payload.
- Chaves existentes não ganham o escopo novo (sem backfill, como `aops:manage`). Nada é cobrado (é
  entrega do que já foi cobrado). Logs e auditoria só com ids, tipos e códigos;
  nunca URL completa (só o host), e-mails, segredo ou payload.

## 5. Testes e aceite

Paridade com `test_notify.py`, traduzida ao desenho: webhook envia com assinatura e corpo certos;
SMTP ausente → `config_missing` explícito; erro HTTP → código fixo; e-mail com STARTTLS e login;
falha de um destino não derruba os outros; sem destino assinante → nada enfileirado; ação reversível
executa e notifica; falha de notificação não derruba a ação.

Mais: unidade da assinatura (vetor fixo), da cifra (ida e volta; texto cifrado adulterado falha) e da
checagem de endereço (tabela de IPv4/IPv6 permitidos e recusados, incluindo `::ffff:127.0.0.1`);
classificação de erro retentável/definitivo e a escada de espera. Int: RLS das duas tabelas; limite de
10; enfileirar idempotente (mesmo evento duas vezes → uma linha); dois workers não enviam a mesma
entrega; posse vencida é retomada; limpeza de 30 dias; `notification_due_tenant_ids()` ignora
suspenso. E2E: escopo (403); CRUD com segredo só na criação e na rotação; 404 entre tenants; URL
interna → 422; teste → 202 e o receptor local recebe com assinatura válida; 409 no segundo teste no
minuto; alerta do monitor e fim de AOP chegam ao webhook e ao e-mail (`mock`); receptor responde 500
→ nova tentativa agendada; 410 → `failed` sem nova tentativa; listagem de entregas sem payload.

## 6. O que fica com quem implementa

Nomes internos, textos dos e-mails, formato do cursor, como forçar o relógio nos testes, onde mora o
coletor do modo `mock`, e a biblioteca para a checagem de faixas IP (implementação própria com
`node:net` é aceitável).
