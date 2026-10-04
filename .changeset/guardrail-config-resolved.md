---
"@kindgi/guardrails": patch
"@kindgi/handler-runtime": patch
---

A TypeScript guardrail's config is resolved by its check's `configSchema`, as Python's guardrails do. `defineCheck`'s `evaluate` gets the schema's defaults applied (a guardrail that declares no config gets them all, so `z.number().default(1)` is 1, not `undefined`), and a config that doesn't fit is refused, naming where. The indexer checks each guardrail's `config` against its schema: a config that doesn't fit, or a required field with no default left out, is a file error, and `kindgi build` refuses the pack.
