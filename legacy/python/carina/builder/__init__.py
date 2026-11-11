"""CARINA Builder Layer — Produto 3 do ``docs/B2B.md`` (fase 3 do roadmap).

Infraestrutura onde terceiros (quants, gestoras, corretoras) constroem
produtos sobre os dados e agentes do CARINA. Diferente do HIP-3 do
Hyperliquid, esta camada é REGULADA: estratégias são especificações
**declarativas** validadas pelo CARINA — nunca código arbitrário do builder
executando na infraestrutura — para manter auditabilidade e compliance
desde o dia 1.

MVP deste pacote:
  * :mod:`carina.builder.strategies` — registro de estratégias por tenant.
  * :mod:`carina.builder.backtest`  — backtesting determinístico sobre o
    Market Data BR normalizado (Camada 1 do Data Engine).
"""
