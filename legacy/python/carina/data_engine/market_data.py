"""Market Data BR normalizado — Camada 1 do Data Engine.

Arquitetura em adapter (mesmo padrão do Open Finance): a fronteira é
:class:`MarketDataProvider` / :class:`MacroProvider`; as implementações atuais
são :class:`BrapiProvider` (cotações e histórico — https://brapi.dev) e
:class:`BcbProvider` (macro via SGS do Banco Central). Trocar/adicionar fonte
(EODHD, B3 direto) = nova classe, sem tocar no resto.

Saída SEMPRE normalizada (:class:`Quote` / :class:`HistoricalBar` /
:class:`MacroIndicator`) — nenhum chamador vê o formato bruto da fonte.

O :class:`MarketDataService` aplica cache TTL em memória por símbolo para
proteger os rate limits das fontes (cotação 60s, histórico 10min, macro 1h).
"""

from __future__ import annotations

import abc
import asyncio
import time
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable

import httpx
from pydantic import BaseModel, Field

from carina.config.settings import Settings, get_settings
from carina.utils.errors import IntegrationError
from carina.utils.logging import get_logger

_log = get_logger("data_engine.market_data")

_HTTP_TIMEOUT = 30.0
_TTL_QUOTE_S = 60.0
_TTL_HISTORY_S = 600.0
_TTL_MACRO_S = 3600.0

#: Séries do SGS/BCB expostas como indicadores macro normalizados.
_BCB_SERIES: dict[str, tuple[int, str, str]] = {
    "selic": (432, "Meta Selic", "% a.a."),
    "cdi": (4389, "CDI anualizado", "% a.a."),
    "ipca": (433, "IPCA (variação mensal)", "% a.m."),
    "ptax_usd": (1, "Dólar PTAX (venda)", "BRL/USD"),
}


class AssetClass(str, Enum):
    """Classe do ativo inferida do ticker B3 (heurística documentada)."""

    STOCK = "stock"
    BDR = "bdr"
    FUND = "fund"  # FII, ETF ou Unit — sufixo 11 é ambíguo entre eles
    INDEX = "index"
    UNKNOWN = "unknown"


def infer_asset_class(symbol: str) -> AssetClass:
    """Infere a classe do ativo pelo sufixo numérico do ticker B3.

    Heurística: 3/4/5/6/7/8 → ação; 31–39 → BDR; 11 → FII/ETF/Unit (``FUND``);
    prefixo ``^`` → índice. Sufixos desconhecidos → ``UNKNOWN``.
    """
    s = symbol.upper().strip()
    if s.startswith("^"):
        return AssetClass.INDEX
    digits = ""
    for ch in reversed(s):
        if not ch.isdigit():
            break
        digits = ch + digits
    if digits in {"3", "4", "5", "6", "7", "8"}:
        return AssetClass.STOCK
    if len(digits) == 2 and digits.startswith("3"):
        return AssetClass.BDR
    if digits == "11":
        return AssetClass.FUND
    return AssetClass.UNKNOWN


class Quote(BaseModel):
    """Cotação normalizada de um ativo."""

    symbol: str
    name: str = ""
    asset_class: AssetClass = AssetClass.UNKNOWN
    price: float
    change_pct: float = 0.0
    previous_close: float | None = None
    volume: float | None = None
    market_cap: float | None = None
    currency: str = "BRL"
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class HistoricalBar(BaseModel):
    """Barra OHLCV diária normalizada."""

    date: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class MacroIndicator(BaseModel):
    """Indicador macroeconômico normalizado (BCB)."""

    code: str
    name: str
    value: float
    unit: str
    reference_date: str = ""


# ── Provedores ───────────────────────────────────────────────────────────────


class MarketDataProvider(abc.ABC):
    """Fronteira abstrata de uma fonte de cotações/histórico."""

    @abc.abstractmethod
    async def fetch_quotes(self, symbols: list[str]) -> list[Quote]:
        """Cotações atuais dos símbolos pedidos."""

    @abc.abstractmethod
    async def fetch_history(self, symbol: str, range_: str = "3mo") -> list[HistoricalBar]:
        """Histórico diário de um símbolo (``range_`` no formato da fonte: 1mo, 3mo, 1y...)."""


class MacroProvider(abc.ABC):
    """Fronteira abstrata de uma fonte de indicadores macro."""

    @abc.abstractmethod
    async def fetch_macro(self) -> list[MacroIndicator]:
        """Indicadores macro correntes (Selic, CDI, IPCA, PTAX)."""


class BrapiProvider(MarketDataProvider):
    """Adapter do brapi.dev (cotações e histórico B3).

    Token opcional (``BRAPI_TOKEN``) — sem token o free tier tem limites mais
    baixos, suficientes para desenvolvimento.

    Args:
        settings: Token e base URL.
        http: Cliente httpx injetável (testes).
    """

    def __init__(self, settings: Settings | None = None, http: httpx.AsyncClient | None = None):
        self._settings = settings or get_settings()
        self._http = http or httpx.AsyncClient(timeout=_HTTP_TIMEOUT)

    async def _get(self, path: str, params: dict[str, Any]) -> dict:
        if self._settings.brapi_token:
            params = {**params, "token": self._settings.brapi_token}
        base = self._settings.brapi_base_url.rstrip("/")
        resp = await self._http.get(f"{base}{path}", params=params)
        if resp.status_code != 200:
            raise IntegrationError(f"brapi GET {path}: HTTP {resp.status_code}")
        return resp.json()

    async def fetch_quotes(self, symbols: list[str]) -> list[Quote]:
        joined = ",".join(s.upper().strip() for s in symbols)
        payload = await self._get(f"/quote/{joined}", {})
        quotes: list[Quote] = []
        for raw in payload.get("results", []):
            symbol = raw.get("symbol", "")
            quotes.append(
                Quote(
                    symbol=symbol,
                    name=raw.get("shortName") or raw.get("longName") or "",
                    asset_class=infer_asset_class(symbol),
                    price=float(raw.get("regularMarketPrice") or 0.0),
                    change_pct=float(raw.get("regularMarketChangePercent") or 0.0),
                    previous_close=(
                        float(raw["regularMarketPreviousClose"])
                        if raw.get("regularMarketPreviousClose") is not None
                        else None
                    ),
                    volume=(
                        float(raw["regularMarketVolume"])
                        if raw.get("regularMarketVolume") is not None
                        else None
                    ),
                    market_cap=(
                        float(raw["marketCap"]) if raw.get("marketCap") is not None else None
                    ),
                    currency=raw.get("currency") or "BRL",
                )
            )
        _log.info("market_data.quotes", symbols=joined, count=len(quotes))
        return quotes

    async def fetch_history(self, symbol: str, range_: str = "3mo") -> list[HistoricalBar]:
        payload = await self._get(
            f"/quote/{symbol.upper().strip()}", {"range": range_, "interval": "1d"}
        )
        results = payload.get("results", [])
        raw_bars = results[0].get("historicalDataPrice", []) if results else []
        bars = [
            HistoricalBar(
                date=datetime.fromtimestamp(int(b["date"]), tz=timezone.utc),
                open=float(b.get("open") or 0.0),
                high=float(b.get("high") or 0.0),
                low=float(b.get("low") or 0.0),
                close=float(b.get("close") or 0.0),
                volume=float(b.get("volume") or 0.0),
            )
            for b in raw_bars
            if b.get("date") is not None
        ]
        _log.info("market_data.history", symbol=symbol, bars=len(bars))
        return bars


class BcbProvider(MacroProvider):
    """Adapter do SGS (Sistema Gerenciador de Séries Temporais) do BCB.

    API pública, sem chave. Séries em :data:`_BCB_SERIES`.
    """

    def __init__(self, settings: Settings | None = None, http: httpx.AsyncClient | None = None):
        self._settings = settings or get_settings()
        self._http = http or httpx.AsyncClient(timeout=_HTTP_TIMEOUT)

    async def _last_value(self, series_id: int) -> tuple[float, str]:
        base = self._settings.bcb_base_url.rstrip("/")
        resp = await self._http.get(
            f"{base}/dados/serie/bcdata.sgs.{series_id}/dados/ultimos/1",
            params={"formato": "json"},
        )
        if resp.status_code != 200:
            raise IntegrationError(f"BCB SGS {series_id}: HTTP {resp.status_code}")
        rows = resp.json()
        if not rows:
            raise IntegrationError(f"BCB SGS {series_id}: série vazia")
        row = rows[-1]
        return float(str(row["valor"]).replace(",", ".")), str(row.get("data", ""))

    async def fetch_macro(self) -> list[MacroIndicator]:
        async def _one(code: str, series_id: int, name: str, unit: str) -> MacroIndicator:
            value, ref = await self._last_value(series_id)
            return MacroIndicator(code=code, name=name, value=value, unit=unit, reference_date=ref)

        indicators = await asyncio.gather(
            *(_one(code, sid, name, unit) for code, (sid, name, unit) in _BCB_SERIES.items())
        )
        _log.info("market_data.macro", count=len(indicators))
        return list(indicators)


# ── Cache TTL ────────────────────────────────────────────────────────────────


class TTLCache:
    """Cache em memória com expiração por chave (protege rate limits das fontes).

    Args:
        now_fn: Relógio monotônico injetável (testes).
    """

    def __init__(self, now_fn: Callable[[], float] = time.monotonic) -> None:
        self._now = now_fn
        self._data: dict[str, tuple[float, Any]] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> Any | None:
        async with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            expires, value = entry
            if self._now() >= expires:
                del self._data[key]
                return None
            return value

    async def set(self, key: str, value: Any, ttl_s: float) -> None:
        async with self._lock:
            self._data[key] = (self._now() + ttl_s, value)


# ── Serviço ──────────────────────────────────────────────────────────────────


class MarketDataService:
    """Fachada normalizada do Market Data BR, com cache TTL por chave.

    Args:
        provider: Fonte de cotações/histórico. Default: :class:`BrapiProvider`.
        macro_provider: Fonte macro. Default: :class:`BcbProvider`.
        cache: Cache TTL. Default: novo :class:`TTLCache`.
    """

    def __init__(
        self,
        provider: MarketDataProvider | None = None,
        macro_provider: MacroProvider | None = None,
        settings: Settings | None = None,
        cache: TTLCache | None = None,
    ) -> None:
        self._provider = provider or BrapiProvider(settings=settings)
        self._macro = macro_provider or BcbProvider(settings=settings)
        self._cache = cache or TTLCache()

    async def quotes(self, symbols: list[str]) -> list[Quote]:
        """Cotações normalizadas (cache 60s por símbolo; busca só o que falta)."""
        normalized = [s.upper().strip() for s in symbols if s.strip()]
        cached: dict[str, Quote] = {}
        missing: list[str] = []
        for symbol in normalized:
            hit = await self._cache.get(f"quote:{symbol}")
            if hit is not None:
                cached[symbol] = hit
            else:
                missing.append(symbol)

        if missing:
            for quote in await self._provider.fetch_quotes(missing):
                cached[quote.symbol] = quote
                await self._cache.set(f"quote:{quote.symbol}", quote, _TTL_QUOTE_S)

        return [cached[s] for s in normalized if s in cached]

    async def history(self, symbol: str, range_: str = "3mo") -> list[HistoricalBar]:
        """Histórico diário normalizado (cache 10min)."""
        key = f"history:{symbol.upper().strip()}:{range_}"
        hit = await self._cache.get(key)
        if hit is not None:
            return hit
        bars = await self._provider.fetch_history(symbol, range_=range_)
        await self._cache.set(key, bars, _TTL_HISTORY_S)
        return bars

    async def macro(self) -> list[MacroIndicator]:
        """Indicadores macro BCB normalizados (cache 1h)."""
        hit = await self._cache.get("macro")
        if hit is not None:
            return hit
        indicators = await self._macro.fetch_macro()
        await self._cache.set("macro", indicators, _TTL_MACRO_S)
        return indicators
