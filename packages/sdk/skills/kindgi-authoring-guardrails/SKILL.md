---
name: kindgi-authoring-guardrails
description: >
  Covers writing guardrails (safety checks) for a Kindgi pack: the check
  implementation via defineCheck from @kindgi/sdk/define, the guardrail
  declaration a pack file default-exports (the indexer's shape), the three
  kinds (zero-llm / llm-judge / external), actions, severity levels, scope
  selectors, config schemas via Zod or JSON Schema, validating a declaration
  with validateGuardrail from @kindgi/guardrails, and how guardrails reach
  agents. A guardrail judges the final answer, or with `at` a tool call
  (before or after it) or each model reply that asks for tool calls. halt
  fails the turn; retry sends the answer or reply back, refuses the call or
  withholds its result; escalate / compensate are final-answer only and
  only recorded. A check sees only the current turn. Load this whenever you
  are authoring or editing code inside a pack's guardrails/ directory,
  defining a check, or wiring a guardrail onto an agent. Authoring tools is
  covered by kindgi-authoring-tools; authoring agents by
  kindgi-authoring-agents.
type: core
library: "@kindgi/sdk"
version: "0.4.3"
sdk_version: "0.0.0"
pack_languages: [node]
sources:
  - packages/guardrails/src/types.ts
  - packages/guardrails/src/define-check.ts
  - packages/guardrails/src/define.ts
  - packages/guardrails/src/judge.ts
  - packages/guardrails/src/checks.ts
  - packages/handler-runtime/src/kindgi-index.ts
  - packages/handler-runtime/src/handler-runner.ts
---

# Authoring Kindgi guardrails

> **Running `kindgi`:** the CLI is a devDependency of the project (`@kindgi/cli`),
> not a global command. Run it through the project's package manager —
> `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm), `yarn kindgi …` or
> `bun run kindgi …`. Commands below are written `kindgi …` for brevity.

A **guardrail** is a safety rule an agent turn must satisfy. It combines
a **check** (the function that inspects the turn's trace) with an
**action** (what happens when the check fails). In a pack, a guardrail
lives at `guardrails/<name>/index.ts`. For an agent turn, the runtime
evaluates every guardrail the agent lists where its `at` says: once, on
the final response before it's stored (`'final-answer'`, the default), or
in the agent loop, on each tool call before it runs (`'before-tool'`),
on each call's result before the model sees it (`'after-tool'`), or on
each model reply that asks for calls, before any of them runs
(`'model-step'`).

Read [what-it-can-do.md](what-it-can-do.md) before you plan one: what
`halt` and `retry` do at each point, that `escalate` and `compensate` are
only recorded, that a check sees only the current turn, and that its
in-memory state doesn't last.

## Guardrail vs check

- **Check** — the implementation. `defineCheck({ id, kind, points?,
  configSchema?, evaluate })` from `@kindgi/sdk/define` returns a check
  whose `evaluate(config, trace, bindings)` resolves to `{ passed,
  reason? }`. `points` names where it can run; left out, it's
  `['final-answer']`.
- **Guardrail** — the declaration: `id`, `kind`, the `check` it uses,
  the check's `config`, `at`, and `action` / `severity` / `scope`. One
  check can back many guardrails with different configs, each at one of
  the check's points.
- **Built-in checks** (`BUILT_IN_CHECK_IDS` in `@kindgi/guardrails`) can
  be named instead of shipping a check. Their ids are reserved
  (`reserved-check-id`), so name yours `<pack>.checks.<name>`.

A pack file exports its check by name and default-exports the guardrail
as a plain object (`@kindgi/sdk` has no helper for it): the indexer
reads only the default export.

## Your case: read this file

| Your case | Read |
|---|---|
| A pack guardrail file with its own check, and how the indexer reads it | [pack-guardrail-file.md](pack-guardrail-file.md) |
| A guardrail on a tool call, its result or a model reply (`at`) | [in-the-agent-loop.md](in-the-agent-loop.md) |
| Naming a built-in check, and each one's `config` | [built-in-checks.md](built-in-checks.md) |
| Each field: `kind`, `config`, `at`, `action`, `severity`, `scope`, `budget` | [field-by-field.md](field-by-field.md) |
| A model judges the turn against a rubric (`llm-judge`, costs money) | [llm-judge.md](llm-judge.md) |
| Testing a declaration with `validateGuardrail`, or changing a guardrail | [changing-and-testing.md](changing-and-testing.md) |
| An error, or a guardrail that won't index or run | [common-mistakes.md](common-mistakes.md) |

## Wiring the guardrail onto an agent

Agents reference guardrails by id:

```ts
// agents/brief-writer/index.ts
guardrails: ['acme.no-fabricated-quotes'],
```

At the start of each turn, the runtime resolves these ids against the
guardrails available to the run. An id that isn't registered fails the
turn before the model is called (`Error [invalid-request]: Agent "…"
references guardrails not in the registry: <id>`), so register the
guardrail before an agent references it.

## References

- Type surface: hover any `@kindgi/sdk/define` export for full JSDoc;
  `Guardrail`, `validateGuardrail` and the built-in checks are in
  `@kindgi/guardrails`.
- API reference: https://docs.kindgi.com/v0.6/reference/typescript/sdk/kindgi/sdk/define/
- Built-in check implementations: `packages/guardrails/src/checks.ts`.

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/sdk` itself
(guardrail runtime dropping context fields, check-sandbox dispatch
regression, misleading error message, CLI friction) — not in the
pack's own code — load the `kindgi-framework-feedback` skill and file
a structured report with `kindgi feedback write`. That diagnostic is
high-signal input the maintainers can act on; don't let it disappear
into the transcript.
