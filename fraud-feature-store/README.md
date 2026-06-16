# Fraud Feature Store

Feature store de ponta a ponta para detecção de fraude em transações financeiras,
construída com Feast, Redis, Parquet e scikit-learn.

> **Em construção** — este README cresce junto com o projeto. A documentação
> completa (arquitetura, trade-offs, guia de estudo) é adicionada ao final.

## Etapa 1 — Geração de dados

`src/fraud_fs/generate_data.py` produz transações sintéticas com Faker e injeta
três padrões de fraude (valor fora do perfil, sequência rápida, viagem impossível),
tudo reprodutível via `SEED`.

```bash
python -m fraud_fs.generate_data
```
