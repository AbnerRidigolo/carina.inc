"""Open Finance via agregador licenciado — implementação Pluggy.

Arquitetura em adapter: :class:`OpenFinanceProvider` é a fronteira abstrata;
:class:`PluggyProvider` é a implementação atual (https://docs.pluggy.ai).
Trocar de provedor (Belvo, participação direta no Bacen) = nova classe, sem
tocar no resto do código.

Conceitos:
  * **Item** (termo do Pluggy): uma conexão consentida com uma instituição
    (criada pelo widget Pluggy Connect no onboarding do cliente final).
  * **ConnectionRegistry**: mapeia ``client_id`` (já no namespace do tenant) →
    itens conectados. É o que o Sync varre para consolidar.

Saída SEMPRE normalizada (:class:`Position` / :class:`Transaction`) — nenhum
chamador vê o formato bruto do provedor.
"""

from __future__ import annotations

import abc
import asyncio
from datetime import date, datetime, timezone
from typing import Any

import httpx
from pydantic import BaseModel, Field

from carina.config.settings import Settings, get_settings
from carina.knowledge.ingest import Document
from carina.utils.errors import IntegrationError
from carina.utils.logging import get_logger

_log = get_logger("integrations.open_finance")

_PAGE_SIZE = 200
_HTTP_TIMEOUT = 30.0


class Position(BaseModel):
    """Posição normalizada (investimento ou saldo em conta)."""

    id: str
    item_id: str
    institution: str = ""
    name: str
    kind: str = Field(description="'investment' ou 'cash'.")
    asset_code: str = Field(default="", description="Ticker/código quando houver.")
    quantity: float | None = None
    value: float
    currency: str = "BRL"

    def to_document(self) -> Document:
        """Documento idempotente para ingestão no grafo (id estável)."""
        parts = [f"Posição: {self.name}", f"valor {self.value:.2f} {self.currency}"]
        if self.asset_code:
            parts.append(f"ativo {self.asset_code}")
        if self.quantity is not None:
            parts.append(f"quantidade {self.quantity}")
        if self.institution:
            parts.append(f"instituição {self.institution}")
        return Document(
            document_id=f"position:{self.id}",
            text="; ".join(parts) + ".",
            metadata={"source": "open_finance", "kind": self.kind, "item_id": self.item_id},
        )


class Transaction(BaseModel):
    """Transação normalizada."""

    id: str
    item_id: str
    account_id: str
    date: datetime
    description: str
    amount: float
    currency: str = "BRL"
    category: str = ""

    def to_document(self) -> Document:
        """Documento idempotente para ingestão no grafo (id estável)."""
        text = (
            f"Transação em {self.date.date().isoformat()}: {self.description}; "
            f"valor {self.amount:.2f} {self.currency}"
        )
        if self.category:
            text += f"; categoria {self.category}"
        return Document(
            document_id=f"transaction:{self.id}",
            text=text + ".",
            metadata={"source": "open_finance", "item_id": self.item_id},
        )


# ── Provedor ─────────────────────────────────────────────────────────────────


class OpenFinanceProvider(abc.ABC):
    """Fronteira abstrata de um agregador Open Finance."""

    @abc.abstractmethod
    async def fetch_positions(self, item_id: str) -> list[Position]:
        """Posições (investimentos + saldos) de uma conexão."""

    @abc.abstractmethod
    async def fetch_transactions(
        self, item_id: str, since: date | None = None
    ) -> list[Transaction]:
        """Transações de uma conexão, opcionalmente a partir de uma data."""


class PluggyProvider(OpenFinanceProvider):
    """Adapter do Pluggy (https://docs.pluggy.ai).

    Autentica via ``POST /auth`` (clientId/clientSecret → apiKey válida ~2h);
    re-autentica automaticamente em 401/403. Pagina transações.

    Args:
        settings: Credenciais (``OPEN_FINANCE_CLIENT_ID/SECRET``, base URL).
        http: Cliente httpx injetável (testes). Default: novo ``AsyncClient``.
    """

    def __init__(self, settings: Settings | None = None, http: httpx.AsyncClient | None = None):
        self._settings = settings or get_settings()
        self._http = http or httpx.AsyncClient(timeout=_HTTP_TIMEOUT)
        self._api_key: str | None = None
        self._auth_lock = asyncio.Lock()

    @property
    def _base(self) -> str:
        return self._settings.open_finance_base_url.rstrip("/")

    async def _auth(self) -> str:
        s = self._settings
        if not s.open_finance_client_id or not s.open_finance_client_secret:
            raise IntegrationError(
                "Credenciais Open Finance ausentes — configure "
                "OPEN_FINANCE_CLIENT_ID/OPEN_FINANCE_CLIENT_SECRET no .env"
            )
        resp = await self._http.post(
            f"{self._base}/auth",
            json={
                "clientId": s.open_finance_client_id,
                "clientSecret": s.open_finance_client_secret,
            },
        )
        if resp.status_code != 200:
            raise IntegrationError(f"Falha na autenticação Pluggy: HTTP {resp.status_code}")
        api_key = resp.json().get("apiKey")
        if not api_key:
            raise IntegrationError("Resposta de auth do Pluggy sem apiKey")
        return api_key

    async def _get(self, path: str, params: dict[str, Any]) -> dict:
        """GET autenticado com re-auth única em 401/403."""
        async with self._auth_lock:
            if self._api_key is None:
                self._api_key = await self._auth()
        resp = await self._http.get(
            f"{self._base}{path}", params=params, headers={"X-API-KEY": self._api_key}
        )
        if resp.status_code in (401, 403):
            async with self._auth_lock:
                self._api_key = await self._auth()
            resp = await self._http.get(
                f"{self._base}{path}", params=params, headers={"X-API-KEY": self._api_key}
            )
        if resp.status_code != 200:
            raise IntegrationError(f"Pluggy GET {path}: HTTP {resp.status_code}")
        return resp.json()

    async def fetch_positions(self, item_id: str) -> list[Position]:
        positions: list[Position] = []

        accounts = (await self._get("/accounts", {"itemId": item_id})).get("results", [])
        for acc in accounts:
            if acc.get("type") != "BANK":
                continue  # cartão de crédito não é posição; entra via transações
            positions.append(
                Position(
                    id=str(acc["id"]),
                    item_id=item_id,
                    institution=acc.get("name", ""),
                    name=acc.get("marketingName") or acc.get("name", "Conta"),
                    kind="cash",
                    value=float(acc.get("balance") or 0.0),
                    currency=acc.get("currencyCode") or "BRL",
                )
            )

        investments = (await self._get("/investments", {"itemId": item_id})).get("results", [])
        for inv in investments:
            positions.append(
                Position(
                    id=str(inv["id"]),
                    item_id=item_id,
                    institution=inv.get("issuer") or "",
                    name=inv.get("name", "Investimento"),
                    kind="investment",
                    asset_code=inv.get("code") or "",
                    quantity=float(inv["quantity"]) if inv.get("quantity") is not None else None,
                    value=float(inv.get("balance") or inv.get("amount") or 0.0),
                    currency=inv.get("currencyCode") or "BRL",
                )
            )

        _log.info("open_finance.positions", item_id=item_id, count=len(positions))
        return positions

    async def fetch_transactions(
        self, item_id: str, since: date | None = None
    ) -> list[Transaction]:
        accounts = (await self._get("/accounts", {"itemId": item_id})).get("results", [])
        transactions: list[Transaction] = []
        for acc in accounts:
            account_id = str(acc["id"])
            page = 1
            while True:
                params: dict[str, Any] = {
                    "accountId": account_id,
                    "page": page,
                    "pageSize": _PAGE_SIZE,
                }
                if since is not None:
                    params["from"] = since.isoformat()
                payload = await self._get("/transactions", params)
                for tx in payload.get("results", []):
                    transactions.append(
                        Transaction(
                            id=str(tx["id"]),
                            item_id=item_id,
                            account_id=account_id,
                            date=_parse_date(tx.get("date")),
                            description=tx.get("description") or "",
                            amount=float(tx.get("amount") or 0.0),
                            currency=tx.get("currencyCode") or "BRL",
                            category=tx.get("category") or "",
                        )
                    )
                if page >= int(payload.get("totalPages") or 1):
                    break
                page += 1

        _log.info("open_finance.transactions", item_id=item_id, count=len(transactions))
        return transactions


def _parse_date(raw: str | None) -> datetime:
    if not raw:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ── Registro de conexões ─────────────────────────────────────────────────────


class ConnectionRegistry(abc.ABC):
    """Mapeia clientes (id efetivo, com namespace do tenant) → itens conectados."""

    @abc.abstractmethod
    async def add(self, client_id: str, item_id: str) -> None:
        """Registra uma conexão consentida."""

    @abc.abstractmethod
    async def remove(self, client_id: str, item_id: str) -> bool:
        """Remove uma conexão; ``True`` se existia."""

    @abc.abstractmethod
    async def list_items(self, client_id: str) -> list[str]:
        """Itens conectados de um cliente."""

    @abc.abstractmethod
    async def list_clients(self) -> list[str]:
        """Todos os clientes com pelo menos uma conexão (para o Sync job)."""


class InMemoryConnectionRegistry(ConnectionRegistry):
    """Registro em memória (dev/testes). NÃO persiste entre processos."""

    def __init__(self) -> None:
        self._data: dict[str, set[str]] = {}
        self._lock = asyncio.Lock()

    async def add(self, client_id: str, item_id: str) -> None:
        async with self._lock:
            self._data.setdefault(client_id, set()).add(item_id)

    async def remove(self, client_id: str, item_id: str) -> bool:
        async with self._lock:
            items = self._data.get(client_id, set())
            if item_id not in items:
                return False
            items.discard(item_id)
            return True

    async def list_items(self, client_id: str) -> list[str]:
        async with self._lock:
            return sorted(self._data.get(client_id, set()))

    async def list_clients(self) -> list[str]:
        async with self._lock:
            return sorted(cid for cid, items in self._data.items() if items)


class FalkorDBConnectionRegistry(ConnectionRegistry):
    """Registro persistente num grafo dedicado ``carina_connections``."""

    def __init__(self, settings: Settings | None = None, graph_name: str = "carina_connections"):
        self._settings = settings or get_settings()
        self._graph_name = graph_name
        self._graph: Any | None = None

    def _ensure_graph(self) -> Any:
        if self._graph is not None:
            return self._graph
        from falkordb import FalkorDB  # import tardio

        s = self._settings
        s.require_falkordb()
        db = FalkorDB(
            host=s.falkordb_host,
            port=s.falkordb_port,
            username=s.falkordb_username or None,
            password=s.falkordb_password or None,
        )
        self._graph = db.select_graph(self._graph_name)
        return self._graph

    async def add(self, client_id: str, item_id: str) -> None:
        def _write() -> None:
            self._ensure_graph().query(
                "MERGE (:Connection {client_id: $cid, item_id: $iid})",
                {"cid": client_id, "iid": item_id},
            )

        await asyncio.to_thread(_write)

    async def remove(self, client_id: str, item_id: str) -> bool:
        def _write() -> bool:
            res = self._ensure_graph().query(
                "MATCH (c:Connection {client_id: $cid, item_id: $iid}) DELETE c RETURN count(c)",
                {"cid": client_id, "iid": item_id},
            )
            return bool(res.result_set and int(res.result_set[0][0]) > 0)

        return await asyncio.to_thread(_write)

    async def list_items(self, client_id: str) -> list[str]:
        def _read() -> list[str]:
            res = self._ensure_graph().query(
                "MATCH (c:Connection {client_id: $cid}) RETURN c.item_id ORDER BY c.item_id",
                {"cid": client_id},
            )
            return [row[0] for row in res.result_set]

        return await asyncio.to_thread(_read)

    async def list_clients(self) -> list[str]:
        def _read() -> list[str]:
            res = self._ensure_graph().query(
                "MATCH (c:Connection) RETURN DISTINCT c.client_id ORDER BY c.client_id"
            )
            return [row[0] for row in res.result_set]

        return await asyncio.to_thread(_read)


# ── Cliente de alto nível ────────────────────────────────────────────────────


class OpenFinanceClient:
    """Consolida Open Finance por cliente, agregando todas as conexões.

    Falha de UM item não derruba a consolidação dos demais (logada e pulada) —
    instituições ficam indisponíveis com frequência.

    Args:
        provider: Adapter do agregador. Default: :class:`PluggyProvider`.
        registry: Registro de conexões. Default: :class:`InMemoryConnectionRegistry`.
    """

    def __init__(
        self,
        provider: OpenFinanceProvider | None = None,
        registry: ConnectionRegistry | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._provider = provider or PluggyProvider(settings=settings)
        self.registry = registry or InMemoryConnectionRegistry()

    async def fetch_positions(self, client_id: str) -> list[Position]:
        """Posições consolidadas de todas as conexões do cliente."""
        return await self._gather(client_id, self._provider.fetch_positions)

    async def fetch_transactions(
        self, client_id: str, since: date | None = None
    ) -> list[Transaction]:
        """Transações consolidadas de todas as conexões do cliente."""

        async def _fetch(item_id: str) -> list[Transaction]:
            return await self._provider.fetch_transactions(item_id, since=since)

        return await self._gather(client_id, _fetch)

    async def _gather(self, client_id: str, fetch: Any) -> list:
        items = await self.registry.list_items(client_id)
        if not items:
            return []
        outputs = await asyncio.gather(*(fetch(i) for i in items), return_exceptions=True)
        merged: list = []
        for item_id, out in zip(items, outputs):
            if isinstance(out, Exception):
                _log.warning(
                    "open_finance.item_failed",
                    client_id=client_id,
                    item_id=item_id,
                    error=str(out),
                )
                continue
            merged.extend(out)
        return merged
