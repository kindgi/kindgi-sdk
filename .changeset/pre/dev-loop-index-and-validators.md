---
"@kindgi/handler-runtime": patch
"@kindgi/specs": minor
---

A guardrail's `config` reaches the dev index, and the pack service compiles each tool's schemas once.

- `@kindgi/handler-runtime`:
  - **Fix: guardrail `config` in the index.** The indexer now writes a guardrail's `config` (what its check is configured with) to the index. In `kindgi dev`, a configured guardrail ran without its config.
  - **Validators are compiled once.** The pack service compiles a tool's input and output validators once and reuses them, instead of compiling them on every call: about 12 ms off each tool call. An edited schema compiles again, so hot reload still takes effect.
- `@kindgi/specs`: `pack-index.schema.json` 1.1.0 adds a guardrail's `config`. The Python SDK's vendored copy matches.
