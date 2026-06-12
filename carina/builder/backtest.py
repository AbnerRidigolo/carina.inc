"""Backtesting determinístico sobre barras diárias do Market Data BR.

Sem aleatoriedade e sem lookahead: a posição do dia ``t`` usa o sinal
calculado com dados até ``t-1``. Métricas em base 100 (equity inicial).

Estratégias suportadas (especificação declarativa — ver
:mod:`carina.builder.strategies`):
  * ``buy_hold``  — compra na primeira barra e carrega.
  * ``sma_cross`` — comprado quando a média móvel rápida está acima da lenta;
    em caixa caso contrário.
"""

from __future__ import annotations

import statistics
from datetime import datetime

from pydantic import BaseModel, Field

from carina.data_engine.market_data import HistoricalBar
from carina.utils.errors import BuilderError
from carina.utils.logging import get_logger

_log = get_logger("builder.backtest")

_TRADING_DAYS_PER_YEAR = 252


class BacktestResult(BaseModel):
    """Resultado de um backtest (equity em base 100)."""

    symbol: str
    kind: str
    bars: int
    start: datetime
    end: datetime
    total_return_pct: float
    max_drawdown_pct: float
    annualized_volatility_pct: float
    trades: int
    final_equity: float
    equity_curve: list[float] = Field(default_factory=list)


def _sma(closes: list[float], window: int, end_exclusive: int) -> float | None:
    """Média móvel simples das ``window`` barras anteriores a ``end_exclusive``."""
    if end_exclusive < window:
        return None
    segment = closes[end_exclusive - window : end_exclusive]
    return sum(segment) / window


def _signals(kind: str, closes: list[float], fast: int, slow: int) -> list[bool]:
    """Sinal por barra (``True`` = comprado), usando dados ATÉ a própria barra."""
    if kind == "buy_hold":
        return [True] * len(closes)
    # sma_cross
    signals: list[bool] = []
    for t in range(len(closes)):
        fast_sma = _sma(closes, fast, t + 1)
        slow_sma = _sma(closes, slow, t + 1)
        signals.append(fast_sma is not None and slow_sma is not None and fast_sma > slow_sma)
    return signals


def run_backtest(
    *,
    kind: str,
    symbol: str,
    bars: list[HistoricalBar],
    fast: int = 10,
    slow: int = 50,
) -> BacktestResult:
    """Roda o backtest de uma especificação sobre barras diárias.

    Args:
        kind: ``buy_hold`` ou ``sma_cross``.
        symbol: Símbolo (informativo, para o relatório).
        bars: Barras diárias em ordem cronológica.
        fast: Janela rápida (``sma_cross``).
        slow: Janela lenta (``sma_cross``).

    Raises:
        BuilderError: Histórico insuficiente para a estratégia.
    """
    minimum = 2 if kind == "buy_hold" else slow + 1
    if len(bars) < minimum:
        raise BuilderError(
            f"Histórico insuficiente para '{kind}': {len(bars)} barras (mínimo {minimum})"
        )

    closes = [b.close for b in bars]
    signals = _signals(kind, closes, fast, slow)

    equity = 100.0
    peak = equity
    max_drawdown = 0.0
    trades = 0
    in_position = False
    daily_returns: list[float] = []
    curve: list[float] = [equity]

    for t in range(1, len(closes)):
        position = signals[t - 1]  # sem lookahead: sinal de ontem decide hoje
        if position != in_position:
            trades += 1
            in_position = position
        asset_return = closes[t] / closes[t - 1] - 1
        strategy_return = asset_return if position else 0.0
        daily_returns.append(strategy_return)
        equity *= 1 + strategy_return
        curve.append(round(equity, 4))
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, (peak - equity) / peak)

    volatility = (
        statistics.pstdev(daily_returns) * (_TRADING_DAYS_PER_YEAR**0.5)
        if len(daily_returns) > 1
        else 0.0
    )
    result = BacktestResult(
        symbol=symbol,
        kind=kind,
        bars=len(bars),
        start=bars[0].date,
        end=bars[-1].date,
        total_return_pct=round((equity / 100.0 - 1) * 100, 4),
        max_drawdown_pct=round(max_drawdown * 100, 4),
        annualized_volatility_pct=round(volatility * 100, 4),
        trades=trades,
        final_equity=round(equity, 4),
        equity_curve=curve,
    )
    _log.info(
        "backtest.done",
        symbol=symbol,
        kind=kind,
        bars=result.bars,
        total_return_pct=result.total_return_pct,
        trades=trades,
    )
    return result
