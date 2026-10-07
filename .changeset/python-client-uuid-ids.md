---
"@kindgi/client": patch
---

The Python client takes a model's id straight back: every id parameter (a path or query parameter named `…Id`, or one the API declares as a UUID) accepts `str | UUID`. The models carry ids as `UUID`, so `kindgi.runs.get(run.id)` and `kindgi.approvals.complete(approval.id, decision="approve")` now type-check under pyright and mypy; they always worked at runtime. Lists of ids accept `list[str | UUID]`.
