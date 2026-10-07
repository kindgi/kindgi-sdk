---
"@kindgi/sdk": patch
---

The Python guardrails skill's sample config gives its default as `Field(default=1, …)`, so type checkers such as pyright see the field as optional; `Field(1, …)` made `Config()` look like it needs `minLookups`.
