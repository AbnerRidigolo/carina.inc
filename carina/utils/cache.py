"""Cache de embeddings (e outros resultados determinísticos de modelo).

Embeddings NÃO têm fallback de provedor (ver ``models/router.py``), então devem
ser cacheados agressivamente para reduzir consumo do rate-limit do NIM.

Implementação default: cache em memória + persistência opcional em disco (JSON),
chaveado por ``sha256(model + texto)``. Em produção pode-se trocar por Redis/
FalkorDB sem alterar a interface ``EmbeddingCache``.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path

from carina.utils.logging import get_logger

_log = get_logger(__name__)


def _key(model: str, text: str) -> str:
    """Chave estável de cache a partir do modelo + texto."""
    digest = hashlib.sha256(f"{model}\x00{text}".encode("utf-8")).hexdigest()
    return digest


class EmbeddingCache:
    """Cache thread-safe de vetores de embedding.

    Args:
        persist_dir: Diretório para persistência em disco. ``None`` = só memória.
    """

    def __init__(self, persist_dir: str | os.PathLike[str] | None = None) -> None:
        self._mem: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self._persist_dir: Path | None = Path(persist_dir) if persist_dir else None
        if self._persist_dir is not None:
            self._persist_dir.mkdir(parents=True, exist_ok=True)

    def get(self, model: str, text: str) -> list[float] | None:
        """Retorna o vetor cacheado ou ``None`` se ausente."""
        key = _key(model, text)
        with self._lock:
            if key in self._mem:
                return self._mem[key]
        vec = self._load_from_disk(key)
        if vec is not None:
            with self._lock:
                self._mem[key] = vec
        return vec

    def set(self, model: str, text: str, vector: list[float]) -> None:
        """Armazena um vetor no cache (memória + disco, se habilitado)."""
        key = _key(model, text)
        with self._lock:
            self._mem[key] = vector
        self._save_to_disk(key, vector)

    def _path(self, key: str) -> Path | None:
        return self._persist_dir / f"{key}.json" if self._persist_dir else None

    def _load_from_disk(self, key: str) -> list[float] | None:
        path = self._path(key)
        if path is None or not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:  # pragma: no cover - defensivo
            _log.warning("embedding_cache.read_failed", key=key, error=str(exc))
            return None

    def _save_to_disk(self, key: str, vector: list[float]) -> None:
        path = self._path(key)
        if path is None:
            return
        try:
            path.write_text(json.dumps(vector), encoding="utf-8")
        except OSError as exc:  # pragma: no cover - defensivo
            _log.warning("embedding_cache.write_failed", key=key, error=str(exc))
