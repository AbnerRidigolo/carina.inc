# Módulo `market` e preço de servidor na execução — design (fase 2, frente 1)

Primeira frente da fase 2 do [spec da migração](2026-11-11-migracao-typescript-design.md). As outras
frentes (importação de arquivos, agentes restantes, AOPs e builder, evaluation) ganham o seu próprio
desenho, uma de cada vez. Este documento cobre só o `market` e a sua ligação com a execução de
ordens.

## 1. Intenção e motivo

O Python tem um módulo `market` com três rotas (cotações e histórico da B3, indicadores
macroeconômicos do Banco Central). O spec da migração pede o mesmo na versão TypeScript, com os
mesmos tipos de trabalho cobrados e testes.

O motivo de fazer o `market` primeiro vai além da paridade. Hoje o servidor não tem nenhuma fonte de
preço: o `valueBrl` de uma ordem é um número que o próprio modelo afirma, e é a base da taxa de
execução de 0,5%, gravada numa tabela de cobrança que não se apaga. É a maior limitação de segurança
registrada no README da fase 1. O builder e o backtest, também da fase 2, dependem de cotações do
mesmo módulo.

O projeto é uma peça de portfólio para mostrar ao empregador do dono do repositório (uma casa de
TypeScript e Node). Então a demo continua funcionando sem nenhuma chave de API ou rede, e o que for
dito no README tem de estar provado por teste.

## 2. Objetivos, não objetivos e antiobjetivos

**Objetivos**

- Rotas `GET /api/market/quotes`, `GET /api/market/history/:symbol` e `GET /api/market/macro`,
  equivalentes às do Python, cobradas como `data_query` e cobertas por testes.
- Provedores atrás de interfaces (brapi.dev para cotações e histórico, SGS do Banco Central para
  macro), com saída sempre normalizada. Trocar de fonte é uma classe nova.
- Modo mock determinístico, para a demo e os testes, sem rede e sem chave.
- Para `place_trade` com ativo cotável, o `valueBrl` (base da taxa) passa a vir do preço de
  servidor, nunca do modelo. O aprovador vê o preço, a origem e a hora da cotação.
- Falha fechada: sem cotação confiável, a ordem não chega a ser proposta para aprovação.

**Não objetivos (desta frente)**

- Painel de mercado no frontend. A única mudança de tela aceitável é o aprovador ver o preço e a
  hora da cotação, e só se a tela de aprovações já não mostrar o payload inteiro.
- Cotação em tempo real, streaming de preços, múltiplas fontes com consenso.
- Preço de servidor para `transfer` e `rebalance`. Eles não têm um ativo cotável único; seguem com a
  conferência de consistência da fase 1 e o limite continua no README.
- Nova cotação no momento da execução. A taxa usa o valor que o aprovador viu (ver seção 5).
- Builder, backtest e agentes que consomem o `market`: frentes seguintes.

**Antiobjetivos (falhar mesmo que tecnicamente funcione)**

- A demo exigir rede, chave ou conta em provedor.
- Um número vindo do modelo definir a taxa de um ativo que o servidor sabe cotar.
- Uma queda do provedor virar erro 500, ou virar uma ordem que segue com valor inventado ou zerado.
- Um dado do provedor entrar sem validação, ou um token ou URL com segredo aparecer em log.

## 3. Restrições

- Mesma base: NestJS 12 (ESM), Prisma, Redis, Zod em `packages/shared`, Vitest com Postgres e Redis
  reais, TypeScript `strict`, versões exatas, Node fixado em `.nvmrc`.
- Dinheiro nunca passa por `number` para cálculo: `Decimal` e strings decimais nos contratos.
- Todo teste determinístico, sem rede no CI. O modo live não é exercitado pelo CI, e o README diz
  isso (como já diz para o `LLM_MODE=live`).
- Toda rota não pública declara escopo; a regra é testada na aplicação real.
- Sem regressão: o fluxo completo da fase 1 (R$ 90,00 de execução para R$ 3.000,00) continua
  passando sem alteração de valores.

## 4. Abordagens consideradas

1. **Só a paridade com o Python.** Portar as três rotas e a cobrança, sem tocar no resto. É o mais
   rápido e o mais seguro, mas a limitação do valor afirmado pelo modelo continua aberta.
2. **Paridade mais preço de servidor na execução. Escolhida.** Além das rotas, o executor deixa de
   usar o valor do modelo para `place_trade` e passa a usar o preço de servidor. Fecha a limitação
   de segurança e mantém o critério de aceite. O custo é mexer no fluxo de aprovação que acabou de
   ser revisado, e definir o que acontece quando a cotação não está disponível.
3. **Só o servidor, sem rotas públicas.** Mesmo ganho de segurança sem expor endpoints. Perde o
   critério de aceite (endpoints equivalentes aos do Python) e a demonstração do módulo.

O dono do projeto escolheu a abordagem 2.

## 5. Desenho

### 5.1 Módulo e contratos

`apps/api/src/modules/market/`, com:

- `types` em `@carina/shared`: `Quote`, `HistoricalBar` e `MacroIndicator` normalizados. Preços e
  volumes de moeda são strings decimais; a classe do ativo (`stock`, `bdr`, `fund`, `index`,
  `unknown`) vem da heurística do sufixo do ticker, portada do Python. O `Quote` também carrega a
  hora da cotação e `marketState` (`open` ou `closed`).
- `MarketDataProvider` (cotações e histórico) e `MacroProvider` (macro) como interfaces;
  `BrapiProvider`, `BcbProvider` e `MockMarketProvider` como implementações.
- `MarketService`: cache, proteção contra rajada e cobrança (ver abaixo).
- `MarketController`: as três rotas, atrás das guardas de chave e de limite.

### 5.2 Provedores (modo live)

- **brapi.dev:** cotações e histórico. O token (`BRAPI_TOKEN`) vai no cabeçalho `Authorization`,
  nunca na URL. A URL base vem do ambiente.
- **SGS do Banco Central:** Selic (432), CDI (4389), IPCA (433) e PTAX (1), como no Python.
- Toda resposta externa passa por schema Zod antes de entrar no sistema. Números chegam como JSON
  `number` e viram `Decimal` pela representação textual; valor não finito, negativo ou fora do
  limite de `numeric(18,2)` descarta o item.
- Símbolo validado por expressão regular antes de montar qualquer URL (`^\^?[A-Z0-9]{1,12}$`) e
  codificado; a URL base nunca vem da requisição. Prazo de resposta curto, tamanho máximo da
  resposta, sem reenvio automático além de uma tentativa. Tokens e URLs completas não vão para log.
- Erro de provedor vira um erro de domínio com mensagem fixa (`MarketDataUnavailableError`),
  respondido como RFC 9457 com status 502, como o Python; o texto do provedor só vai para o log.

### 5.3 Cache e cobrança

- Cache no Redis, com prefixo próprio e valor validado ao ler: cotação 60 s, histórico 10 min, macro
  1 h. Os dados são públicos, então a chave do cache não leva o tenant. O tempo vem do `CLOCK`
  injetável nos testes. Uma só busca por chave ao mesmo tempo (single-flight no processo).
- Cada chamada às rotas é cobrada como `data_query` (R$ 0,05), inclusive em acerto de cache, como
  no Python. Provedor fora do ar: nada é cobrado e a cota é devolvida.
- A busca interna de preço para a execução não é cobrada ao cliente.

### 5.4 Escopo e modo de execução

- Novo escopo `market:read` nas três rotas. A chave de demo do app passa a ter `market:read`; a do
  aprovador, não precisa.
- `MARKET_MODE=mock|live`, obrigatório em produção como o `LLM_MODE`. O compose de demo define
  `mock` explicitamente.
- Mock: tabela fixa de preços para os tickers da demo (PETR4 a R$ 30,00, para o roteiro continuar
  em R$ 3.000,00 e R$ 90,00), histórico gerado por semente fixa a partir do símbolo e macro com
  valores fixos. Símbolo fora da tabela: `unknown_asset`, como no live.

### 5.5 Preço de servidor na execução

Só para `place_trade` com `assetCode` válido:

1. Depois que o modelo propõe a ação e antes de criar a aprovação, o grafo trata o preço nesta
   ordem: (a) calcula o identificador da aprovação sobre a proposta do modelo, antes de enriquecer;
   (b) procura a aprovação por esse identificador; (c) se ela já existe (reexecução do mesmo nó no
   mesmo turno), usa o valor e o payload gravados e **não consulta o preço de novo**, então a
   primeira cotação do turno vale e uma queda do provedor entre as duas execuções não deixa
   aprovação órfã; (d) se não existe, consulta o `MarketService`, enriquece e cria a aprovação.
   Para isso o `InboxService` ganha uma leitura por identificador, e `inbox.request` passa a
   receber a base do identificador separada do payload que será gravado. A idempotência e o
   discriminador de turno da fase 1 não mudam.
2. O valor é `quantidade × preço de servidor`, em `Decimal`, arredondado para 2 casas (meio para
   cima). Esse valor substitui o `valueBrl` do modelo. Chaves de valor e de preço que o modelo tenha
   posto no payload são descartadas, e o payload gravado ganha `unitPriceBrl`, `notionalBrl`,
   `priceSource`, `priceAsOf` e `marketState`. O aprovador vê esses campos.
3. **A conferência de consistência da fase 1 sai de `place_trade` com ativo cotável.** O servidor
   vence sempre: o modelo que afirma outro valor ou outro preço, mesmo incoerente com o próprio
   payload, acaba com o valor do servidor, e a proposta não é recusada por isso. O formato do
   payload (lado, código do ativo, quantidade) continua validado. A conferência segue valendo para
   `transfer` e `rebalance`, e `place_trade` com ativo que não passa pela regex do código continua
   recusado como hoje.
4. **Falha fechada.** Se a cotação não está disponível, é antiga demais ou o ativo é desconhecido,
   nenhuma aprovação é criada. O nó devolve a falha do executor com um código (`price_unavailable`,
   `price_stale` ou `unknown_asset`), e a síntese diz que a ordem não pôde ser proposta. Nada é
   cobrado pela execução.
5. **Frescor.** O `Quote` ganha `marketState` (`open` ou `closed`) e a hora da cotação. Com o
   mercado aberto, a cotação tem de ter no máximo 5 minutos (configurável). Com o mercado fechado
   (noite, fim de semana, feriado), vale o último fechamento se ele tem no máximo 5 dias
   (configurável, cobre fim de semana e feriado prolongado), e o aprovador vê `marketState: closed`
   e a hora do fechamento. Fora desses limites, `price_stale`. No mock, a hora da cotação vem do
   `CLOCK` e o estado é sempre `open`, para a demo funcionar a qualquer hora.
6. A taxa de execução continua sendo calculada no momento da execução sobre o `valueBrl` gravado na
   aprovação, que é o valor que o aprovador viu. Não há nova cotação na execução; o intervalo entre o
   pedido e a execução (até o prazo da aprovação) fica registrado como limitação.

## 6. Testes

- **Unidade:** normalização e validação de cada provedor com respostas gravadas como fixture, sem
  rede; heurística de classe do ativo; cálculo do notional (arredondamento, números grandes, sem
  `number`); descarte das chaves de valor do modelo; tabela do mock.
- **Integração (Redis real):** cache com TTL pelo `CLOCK`, single-flight, valor corrompido no Redis
  tratado como falha de cache, nunca como dado.
- **E2E:** cada rota com escopo (403 sem `market:read`), cobrança de R$ 0,05 por chamada (inclusive
  em acerto de cache), provedor fora do ar → 502 sem cobrança e com cota devolvida, símbolo inválido
  → 422, e a regra de escopos da aplicação real passando.
- **Grafo e fluxo:** o preço de servidor substitui o valor do modelo; modelo que afirma outro
  valor ou outro preço ainda assim gera o valor do servidor; cotação indisponível, antiga ou ativo
  desconhecido não cria aprovação; mercado fechado com fechamento recente é aceito e fechamento
  velho demais não; reexecução do nó usa a primeira cotação mesmo com o provedor fora do ar na
  segunda vez, sem aprovação órfã; o fluxo completo da fase 1 segue em R$ 90,00.
- Modo live: não é exercitado pelo CI. Um script de fumaça manual, fora do CI, descrito no README.

## 7. O que fica para quem for construir

- O mapeamento exato das respostas da brapi.dev e das séries do SGS (conferir a documentação
  atual no momento do plano) e os limites da conta gratuita da brapi.dev.
- Nomes finais de variáveis de ambiente e valores padrão de prazo e tamanho máximo da resposta.
- Se a tela de aprovações do web já mostra o payload completo o bastante para o aprovador ver preço
  e hora; se não, o ajuste mínimo.
- A ordem das tarefas, a forma exata do contrato de `place_trade` enriquecido e a documentação
  (README, ARCHITECTURE e a tabela de garantias) com os testes que provam cada afirmação.

## 8. Decisões minhas (para você conferir)

Marcadas aqui porque não vieram da conversa:

- O escopo novo se chama `market:read`, e a chave de demo do app o recebe.
- Provedor fora do ar responde 502 (como o Python), com mensagem fixa.
- Tempos de cache de 60 s, 10 min e 1 h, os mesmos do Python.
- A busca de preço usada pela execução não é cobrada.
- O preço de servidor substitui o valor do modelo, em vez de recusar quando os dois divergem, porque
  o modelo não conhece o preço.
- Idade máxima da cotação de 5 minutos, configurável.
- Falha fechada: sem cotação confiável, a ordem não é proposta.
- Fora do pregão vale o último fechamento (até 5 dias, configurável), mostrado ao aprovador com
  `marketState: closed` e a hora do fechamento. O mercado fechado não bloqueia a ordem, porque a
  aprovação é humana e o aprovador vê a origem do preço.
- Em `place_trade` com ativo cotável, a conferência de consistência da fase 1 sai e o servidor
  vence sempre, em vez de recusar a proposta incoerente. O formato do payload continua validado.
- Reexecução do mesmo nó: o grafo procura a aprovação pelo identificador antes de cotar, então a
  primeira cotação do turno vale, e o `InboxService` ganha uma leitura por identificador e uma
  base de identificador separada do payload gravado.
- No mock, a hora da cotação vem do `CLOCK` e o estado do mercado é sempre aberto.
