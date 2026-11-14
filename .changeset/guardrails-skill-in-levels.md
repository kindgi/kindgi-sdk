---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

The guardrails authoring skill (`kindgi-authoring-guardrails` 0.4.3) loads in levels, as the tools, providers and MCP servers skills do: its `SKILL.md` holds what's true on every path and a table of cases, and each case has its own file beside it (what a guardrail can do, a pack guardrail file, the agent loop, built-in checks, each field, an llm-judge guardrail, testing and changing one, and common mistakes). It corrects three things it said. Its llm-judge example is now a pack file the indexer reads: it default-exports the guardrail, and its check is a pass-only `defineCheck` of kind `llm-judge` (a file with named exports only is `no-default-export`). A test that runs `validateGuardrail` on an llm-judge guardrail registers that check, since the check a guardrail names must be registered, with the same kind. And `retry` sits beside `on-violation` in `action`: `action: { 'on-violation': 'retry', retry: { maxAttempts: 3 } }`. It also says that a pack reaches `@kindgi/guardrails` only through `@kindgi/sdk`, so a test that imports it adds it as a devDependency.
