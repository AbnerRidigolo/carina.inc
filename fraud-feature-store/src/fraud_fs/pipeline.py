"""Operações de ciclo de vida do Feast.

POR QUE o `apply` é o ponto de partida operacional de uma feature store: ele lê as
definições (`feature_repo/definitions.py`) e as registra no *registry*. É o
"deploy" do contrato de features — nada existe para o Feast até ser aplicado, e a
operação é idempotente (reaplicar só reconcilia o que mudou).

(A materialização para o online store é adicionada na etapa de online/serving.)
"""

from __future__ import annotations

import sys

from fraud_fs.config import FEATURE_REPO_DIR
from fraud_fs.store import get_store


def _load_definitions():
    """Importa o módulo de definições do feature_repo (não é um pacote no path)."""
    sys.path.insert(0, str(FEATURE_REPO_DIR))
    import definitions as d  # type: ignore

    return d


def apply_repo() -> None:
    """Registra entidades e feature views no registry (equivale a `feast apply`)."""
    store = get_store()
    d = _load_definitions()
    store.apply([d.account, d.customer_profile, d.transaction_request, d.transaction_risk])
    print("Feast apply concluído: entidade + feature views registradas no registry.")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Operações do Feast")
    parser.add_argument("step", choices=["apply"])
    args = parser.parse_args()

    if args.step == "apply":
        apply_repo()


if __name__ == "__main__":
    main()
