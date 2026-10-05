---
"@kindgi/handler-runtime": patch
---

`KindgiConfig` types two optional fields that `kindgi dev` reads.

- `project`: the project's name, for its dev database and tenant.
- `providers`: the model providers `kindgi dev` registers, as presets (`{ preset, models?, project?, secret?, maxOutputTokens? }`) or full registrations (`{ spec }`). The new `KindgiProviderDeclaration` type describes them.

In `pyproject.toml` they are `project` under `[tool.kindgi]` and `[[tool.kindgi.providers]]`. Both are additive.
