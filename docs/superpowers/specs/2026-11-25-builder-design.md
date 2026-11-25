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

### Tabela de paridade com o Python (valores esperados)

Gerada rodando `run_backtest` de `legacy/python/carina/builder/backtest.py` com `python3 -I` e
`PYTHONPATH=legacy/python` (HistoricalBar, BuilderError e logger substituídos por stubs); datas diárias
a partir de 2026-01-01. Os mesmos valores estão em `apps/api/src/modules/builder/backtest.spec.ts`.

| Caso | kind (fast/slow) | Fechamentos | retorno % | drawdown % | vol. anual. % | trocas | equity final |
|---|---|---|---|---|---|---|---|
| alta_monotonica | buy_hold (10/50) | 100, 101.5, 103.2, 104.9, 106.1, 108, 109.4, 111.3, 112.8, 114.6 | 14.6 | 0.0 | 3.2937 | 1 | 114.6 |
| drawdown | buy_hold (10/50) | 100, 108, 115, 120, 104, 92, 95, 101, 99, 107, 112 | 12.0 | 23.3333 | 118.4684 | 1 | 112.0 |
| cruzamento_simples | sma_cross (2/4) | 100, 102, 104, 106, 108, 110, 70, 50, 40, 30, 20, 10 | -33.9623 | 36.3636 | 168.0369 | 2 | 66.0377 |
| precos_planos | buy_hold (10/50) | 50, 50, 50, 50, 50, 50 | 0.0 | 0.0 | 0.0 | 1 | 100.0 |
| duas_barras | buy_hold (10/50) | 10, 12.5 | 25.0 | 0.0 | 0.0 | 1 | 125.0 |
| sma_varios_cruzamentos | sma_cross (3/7) | 10, 10.4, 10.9, 11.5, 11.2, 10.6, 10.1, 9.7, 9.9, 10.5, 11.3, 12.1, 11.8, 11.0, 10.2, 9.5, 9.8, 10.7, 11.6, 12.4, 13.0, 12.2, 11.1 | -19.5529 | 24.8718 | 65.5076 | 3 | 80.4471 |

Curvas de equity (base 100, arredondadas a 4 casas):

- `alta_monotonica`: [100.0, 101.5, 103.2, 104.9, 106.1, 108.0, 109.4, 111.3, 112.8, 114.6]
- `drawdown`: [100.0, 108.0, 115.0, 120.0, 104.0, 92.0, 95.0, 101.0, 99.0, 107.0, 112.0]
- `cruzamento_simples`: [100.0, 100.0, 100.0, 100.0, 101.8868, 103.7736, 66.0377, 66.0377, 66.0377, 66.0377, 66.0377, 66.0377]
- `precos_planos`: [100.0, 100.0, 100.0, 100.0, 100.0, 100.0]
- `duas_barras`: [100.0, 125.0]
- `sma_varios_cruzamentos`: [100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 107.0796, 104.4248, 97.3451, 90.2655, 84.0708, 84.0708, 84.0708, 84.0708, 89.8688, 94.2173, 88.4193, 80.4471]

## 6. O que fica com quem implementa

Nomes internos, formato do id na resposta, como forjar o histórico nos testes (provedor mock ou
override do `MarketService`).
