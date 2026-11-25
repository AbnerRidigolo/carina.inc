# Design: builder (estratégias declarativas e backtest)

Data: 2026-11-25. Origem: roadmap da Fase 2 e `legacy/python/carina/builder/{strategies,backtest}.py`
(com `tests/test_builder.py` e as rotas `/builder/*` em `carina/api/routes.py`). O usuário delegou a
escolha ("escolha você"); o que não está no Python é decisão nossa e está marcado.

## 1. Intenção

A "Builder Layer" de `docs/B2B.md`: o tenant B2B registra estratégias como ESPECIFICAÇÕES validadas
(nunca código) e roda backtests determinísticos sobre o histórico de mercado normalizado. Regulada e
auditável por construção: não há execução de código do cliente, e o mesmo histórico dá sempre o mesmo
resultado.

## 2. Escopo

Entra: `buy_hold` e `sma_cross` (janelas `fast` 2..200, `slow` 3..400, `fast < slow`); backtest sem
lookahead em base 100 (retorno total, drawdown máximo, volatilidade anualizada com 252 pregões,
número de trocas, equity final, curva); persistência das estratégias no Postgres sob RLS; rotas de
criar, listar, ler e backtestar; cobrança `backtest` (R$ 7,50, já em `pricing.ts`).

Fora: outras estratégias, parâmetros de custo/slippage, otimização de parâmetros, edição ou remoção
de estratégia, tela na web, execução real de ordens.

Anti-objetivos:
- lookahead (usar o fechamento de hoje para decidir a posição de hoje);
- resultado diferente do Python para as mesmas barras;
- estratégia de um tenant visível ou backtestável por outro;
- cobrar backtest que falhou (histórico insuficiente, símbolo desconhecido, provedor fora).

## 3. Abordagem

Porte direto do motor (puro, determinístico) e persistência nova em Postgres (escolhida). O Python
guardava em memória ou num grafo FalkorDB que não existe mais; Postgres sob RLS é o padrão do resto do
núcleo. Alternativa descartada: guardar só no Redis (sem isolamento por RLS, sem durabilidade).

## 4. Desenho

- **Motor (`apps/api/src/modules/builder/backtest.ts`, puro):** `runBacktest({ kind, symbol, bars,
  fast, slow })` com a mesma matemática do Python: sinal do dia `t-1` decide o dia `t`; SMA das
  `window` barras até a própria barra; `minimum` = 2 (`buy_hold`) ou `slow + 1` (`sma_cross`);
  volatilidade = desvio-padrão populacional dos retornos diários × √252; arredondamento a 4 casas como
  o `round` do Python. Barras do `MarketService.history` (preços em string decimal) viram `number`
  para o cálculo. Histórico insuficiente → `ValidationError` com a contagem.
- **Contratos (`packages/shared/src/builder.ts`):** `StrategyKindSchema`, `StrategySpecSchema`
  (com o refinamento `fast < slow` só para `sma_cross`; `symbol` no formato de símbolo B3 do mercado),
  `StrategySchema` (`id`, `name` 1..120, `spec`, `createdAt`), `StrategyCreateSchema`,
  `BacktestResultSchema` (com `usage`).
- **Dado:** tabela `strategy` (migração 0010): `id uuid`, `tenant_id`, `name`, `kind`, `symbol`,
  `fast`, `slow`, `created_at`; RLS com FORCE por tenant; CHECKs espelhando o schema. Limite de
  **100** estratégias por tenant (decisão nossa) → 422 ao passar.
- **Rotas (escopo novo `builder:run`, decisão nossa; o seed o dá à chave de demo com `data:write`):**
  `POST /api/builder/strategies` (201), `GET /api/builder/strategies` (as do tenant, mais novas
  primeiro), `GET /api/builder/strategies/:id` (404 se não existir ou for de outro tenant),
  `POST /api/builder/strategies/:id/backtest?range=` (`range` do `HistoryRangeSchema`, padrão `1y`).
  O backtest busca o histórico pelo `MarketService` (cache e orçamento das rotas; orçamento esgotado →
  503 como as rotas de mercado), reserva a cota mensal como o chat/evaluation, cobra `backtest` só no
  sucesso e estorna a cota se a cobrança falhar. Criar/listar/ler não cobram.
- **Logs:** só ids, `kind` e contagens.

## 5. Testes e aceite

Paridade com `tests/test_builder.py` (nomes traduzidos): `fast < slow`; `buy_hold` em alta monotônica;
drawdown; `sma_cross` sai na virada; sem lookahead no primeiro dia de sinal; histórico insuficiente;
isolamento por tenant; API cria, backtesta e cobra; spec inválida → 422; histórico insuficiente → 422
sem cobrança. Mais uma tabela de paridade com o Python (barras fixas → métricas e curva), gerada
rodando o motor Python. Int: RLS da tabela, limite de 100. E2E: escopo (403), 404 entre tenants, cota
esgotada → 429 sem cobrança, símbolo desconhecido / provedor fora → sem cobrança.

## 6. O que fica com quem implementa

Nomes internos, formato do id na resposta, como forjar o histórico nos testes (provedor mock ou
override do `MarketService`).
