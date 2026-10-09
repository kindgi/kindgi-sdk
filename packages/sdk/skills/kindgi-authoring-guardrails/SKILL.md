---
name: kindgi-authoring-guardrails
description: >
  Covers writing guardrails (safety checks) for a Kindgi pack: the check
  implementation via defineCheck from @kindgi/sdk/define, the guardrail
  declaration a pack file default-exports (the indexer's shape), the
  three kinds (zero-llm / llm-judge / external), action semantics
  (halt / retry / escalate / log-only / compensate), severity levels,
  scope selectors, config schemas via Zod or JSON Schema, validating a
  declaration with defineGuardrail from @kindgi/guardrails, and how
  guardrails reach agents. Load this whenever you are authoring or
  editing code inside a pack's guardrails/ directory, defining a check,
  or wiring a guardrail onto an agent. Authoring tools is covered by
  kindgi-authoring-tools; authoring agents is covered by
  kindgi-authoring-agents.
type: core
library: "@kindgi/sdk"
version: "0.3.7"
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
> `pnpm exec kindgi …`, `npx --no kindgi …` (npm), `yarn kindgi …` or
> `bun run kindgi …`. Commands below are written `kindgi …` for brevity.

A **guardrail** is a safety rule an agent turn must satisfy. It combines
a **check** (the function that inspects the turn's trace) with an
**action** (what happens when the check fails). In a pack, a guardrail
lives at `guardrails/<name>/index.ts`. For an agent turn, the runtime
evaluates every guardrail the agent lists once, on the final response,
before the response is stored.

## Mental model: guardrail vs check

- **Check** — the implementation. `defineCheck({ id, kind, configSchema?,
  evaluate })` from `@kindgi/sdk/define` returns a registered check whose
  `evaluate(config, trace, bindings)` resolves to `{ passed, reason? }`.
  Zero-llm checks are pure over the trace.
- **Guardrail** — the declaration: `id`, `kind`, the `check` it uses,
  the check's `config`, and `action` / `severity` / `scope`. Its type is
  `Guardrail` from `@kindgi/guardrails`. One check can back many
  guardrails with different configs.
- **Built-in checks** (`BUILT_IN_CHECK_IDS` in `@kindgi/guardrails`):
  `must-cite`, `never-call-tool`, `max-tool-calls`, `output-matches`,
  `tool-order`, `required-substring`, `forbidden-substring`. A guardrail
  can name one of these (`check: 'forbidden-substring'`) instead of
  shipping its own check, and the runtime runs the built-in. Their ids
  are reserved: a pack that ships its own check under one is refused
  (`reserved-check-id`), so name yours `<pack>.checks.<name>`. See
  "Using a built-in check" below for each one's `config`.

`@kindgi/sdk` exports `defineCheck` but no helper for the guardrail
itself: a pack file default-exports the declaration as a plain object.

## A pack guardrail file (zero-llm)

```ts
// guardrails/no-fabricated-quotes/index.ts
import { defineCheck } from '@kindgi/sdk/define';
import { z } from 'zod';

// The check implementation. The pack service calls `check.evaluate`.
export const check = defineCheck({
  id: 'acme.checks.no-fabricated-quotes',
  kind: 'zero-llm',
  configSchema: z.object({ minPrecedentCalls: z.number().int().min(0).optional() }),
  evaluate: async (config, trace) => {
    const needed = config.minPrecedentCalls ?? 1;
    const precedentCalls = trace.toolCalls.filter((c) => c.toolName === 'acme.fetch-precedent');
    if (precedentCalls.length < needed) {
      return {
        passed: false,
        reason: `Only ${precedentCalls.length} precedent lookups (need ${needed}+).`,
      };
    }
    return { passed: true };
  },
});

// The guardrail declaration the indexer reads.
export default {
  id: 'acme.no-fabricated-quotes',
  name: 'No fabricated quotations',
  kind: 'zero-llm',
  check,
  action: { 'on-violation': 'halt' },
  severity: 'critical',
};
```

How the pack tooling reads this file:

- The **indexer** (`packages/handler-runtime/src/kindgi-index.ts`)
  recognises a guardrail by a default export with a `kind` and an
  `action` object carrying `on-violation`. It records `id`, `name`,
  `kind`, `action`, `severity`, `scope`, `sandbox` / `limits` /
  `network`, and the check: its id (`check` may be the check id as a
  string, or the check object) and its config schema (from the check's
  `configZod`, `configSchema` or `configJsonSchema`, or a top-level
  `configZod` / `configSchema`), and the declaration's `config` — what
  the check runs with. It does not record `description`, `budget` or
  `judgeCapabilities`. It checks `config` (none counts as `{}`) against
  the config schema: a config that doesn't fit, or a required field with
  no default left out, is a file error naming where, and `kindgi build`
  refuses the pack.
- The **pack service** loads the same module to run the check. It uses
  the module's `evaluate` export, or the `default` / `check` export when
  that is a function or has an `evaluate` method — here, the named
  `check` export. A `defineCheck` check's `evaluate` gets the config its
  schema resolves: the schema's defaults applied (a guardrail that
  declares no config gets them all), and a config that doesn't fit
  refused, naming where.

## Using a built-in check

Name the built-in as the guardrail's `check`, give its `config`, and ship
no check implementation:

```ts
// guardrails/no-guarantees/index.ts
export default {
  id: 'acme.no-guarantees',
  name: 'Never promise a guarantee',
  kind: 'zero-llm',
  check: 'forbidden-substring',
  config: { patterns: ['guaranteed', 'we promise'] },
  action: { 'on-violation': 'halt' },
  severity: 'error',
};
```

Each built-in's `config` (tool lists hold tool ids, as in
`acme.fetch-precedent`):

| Check | Fails when | `config` |
| --- | --- | --- |
| `must-cite` | the answer is empty, or has fewer than `minCitations` matches of `sourcePattern` | `minCitations?: number` (1), `sourcePattern?: string` (a regex; `[…]`-style citations by default) |
| `never-call-tool` | the turn called any tool in `tools` | `tools: string[]` |
| `max-tool-calls` | the turn made more than `max` tool calls | `max?: number` (10) |
| `output-matches` | the answer doesn't match `pattern` (with `negate: true`, it does) | `pattern: string` (a regex), `flags?: string`, `negate?: boolean` |
| `tool-order` | the tools in `sequence` weren't called in that order (others may come between) | `sequence: string[]` |
| `required-substring` | the answer is empty, or lacks any of `patterns` | `patterns: string[]` (plain text), `caseSensitive?: boolean` (false) |
| `forbidden-substring` | the answer contains any of `patterns` | `patterns: string[]` (plain text), `caseSensitive?: boolean` (false) |

**The built-ins don't check their `config` yet.** Nothing refuses a
wrong shape: a setting of the wrong type is ignored, and the check falls
back to its default or to nothing. `never-call-tool` with
`tools: 'acme.refund'` (a string, not a list) forbids nothing and passes
every turn; `output-matches` without a `pattern` fails every turn. Copy
the shapes above exactly.

## Validating a declaration in-process

`defineGuardrail(spec, checks)` from `@kindgi/guardrails` validates a
`Guardrail` against the wire schema and a check registry: the check id
must be registered, the check's `kind` must match, and `config` must
pass the check's config schema. It returns a `Result`; use it in tests
or wherever guardrails are registered in-process.

```ts
import { createCheckRegistry, defineGuardrail } from '@kindgi/guardrails';
import type { GuardrailId } from '@kindgi/sdk/types';

import { check } from './index.js';

const checks = createCheckRegistry([check]); // built-in checks are included
const defined = defineGuardrail(
  {
    id: 'acme.no-fabricated-quotes' as GuardrailId,
    kind: 'zero-llm',
    check: check.id,
    config: { minPrecedentCalls: 2 },
    action: { 'on-violation': 'halt' },
    severity: 'critical',
  },
  checks,
);
if (defined.kind === 'err') {
  throw new Error(`acme.no-fabricated-quotes: ${defined.error.message}`);
}
```

Registering a guardrail through the API (`POST /v1/guardrails`, or
`client.guardrails.author(spec, { projectId })` in `@kindgi/sdk/client`)
stores the declaration only; the check it names must already be
available to the runtime that evaluates it.

## Field-by-field

- **`id`** — `<pack-id>.<guardrail-name>` (kebab-case, dot-namespaced).
  Name the ASSERTION as a positive rule (e.g. `no-fabricated-quotes`,
  `response-not-empty`, `must-cite-source`).
- **`kind`**:
  - `'zero-llm'` — pure function over the trace. Fast, deterministic,
    free. **The default choice for most safety rules.**
  - `'llm-judge'` — a model scores the turn against a rubric. Costs
    money; requires `judgeCapabilities`. See below.
  - `'external'` — evaluated outside the engine. The built-in
    `external` strategy returns an `invalid-guardrail` error; a caller
    that wants external evaluation registers its own strategy.
- **`check`** — the id of a registered check (built-in, or one built
  with `defineCheck`). In a pack file it may also be the check object.
- **`config`** — the check's parameters, validated against the check's
  `configSchema` by `defineGuardrail`. In a pack, the declaration's
  `config` goes into the index and the check runs with it; without one
  it runs with `{}`. A declaration a pack file default-exports isn't run
  through `defineGuardrail`, so nothing validates its `config`: keep it
  valid against the schema yourself. `evaluate` receives the config as
  declared —
  schema defaults are not filled in — so handle absent optional fields.
- **`action.on-violation`** — `'halt'`, `'retry'` (with
  `retry.maxAttempts`, 1–10), `'escalate'` (with `escalateTo`),
  `'log-only'`, `'compensate'` (with `compensateWith`, a tool id). In an
  agent turn, a failed `halt` guardrail fails the turn with
  `guardrail-violation` and the response is not stored; failures with
  any other action are reported in `AgentTurnResult.violations` and the
  turn completes. The action handlers in `@kindgi/guardrails`
  (`retryHandler`, `escalateHandler`, `compensateHandler`, …) record the
  intent for callers that act on it. In 0.1 the runtime acts only on
  `halt`: `retry`, `escalate` and `compensate` are recorded on the
  violation, with no second attempt, escalation or compensating call.
- **`severity`** — `'info'` / `'warn'` / `'error'` (the default) /
  `'critical'`. Orthogonal to `action`: logs and dashboards group by
  severity; execution follows the action. A `log-only` guardrail can
  still be `'critical'`.
- **`scope`** — when the guardrail applies. `{ when: 'always' }` fires
  everywhere; `{ when: 'ci-only' }` blocks CI but not runtime;
  `{ when: 'runtime-only' }` enforces at runtime but not CI. `agents`,
  `flows` and `tenants` lists narrow it further.
- **`budget`** — `{ maxCostUsd?, maxLatencyMs? }`, relevant to
  `llm-judge`. Declarative: the runtime does not enforce it.
- **`judgeCapabilities`** — for `llm-judge`: the capability
  declaration used to route the judge model.

## LLM-judge guardrail (costs money)

An `llm-judge` guardrail does not run custom check code: the engine's
`llm-judge` strategy sends the turn's trace and the rubric in `config`
(`{ rubric, responseFormat?, threshold?, temperature? }`) to a model
routed through `judgeCapabilities`, and parses a PASS/FAIL or a score.

```ts
import type { Guardrail } from '@kindgi/guardrails';
import type { GuardrailId } from '@kindgi/sdk/types';

export const toneProfessional: Guardrail = {
  id: 'acme.tone-professional' as GuardrailId,
  kind: 'llm-judge',
  // Required by the `Guardrail` type; the llm-judge strategy judges
  // with `config` and does not call this check.
  check: 'acme.checks.tone-professional',
  config: {
    rubric: 'The response is professional in tone and contains no slang.',
    responseFormat: 'pass-fail',
  },
  judgeCapabilities: { needs: [{ feature: 'structured-output' }] },
  action: { 'on-violation': 'log-only' },
  severity: 'warn',
  budget: { maxCostUsd: 0.01, maxLatencyMs: 5000 }, // declarative, not enforced
};
```

The judge is resolved from the provider registry passed in the
evaluation bindings (or a pinned `judgeProvider`), under the tenant
policy in those bindings when one is passed. Checks that run in a pack are called with empty
`bindings` — no provider registry — so a pack check cannot call a model
itself; use `kind: 'llm-judge'` for model-based rules.

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

## Changing a guardrail

Guardrails have no `version` field; the id is the stable identifier.
Changing a guardrail's check, config, severity or action changes
behavior for every agent that references it. When you tighten a rule
(raise severity from `warn` to `error`, switch the action from
`log-only` to `halt`), check whether the agents that reference it are
ready for the stricter enforcement.

## Common mistakes

1. **Confusing guardrail and check.** The id in `agent.guardrails: [...]`
   is the GUARDRAIL id, not the check id. The agent binds to
   guardrails; guardrails reference checks.

2. **A check whose `evaluate` always returns `passed: true`.** If you
   are stubbing the check, give the guardrail `action: { 'on-violation':
   'log-only' }` so it is honest about not being enforced.

3. **Calling a model from a pack check.** Pack checks receive empty
   `bindings`; there is no provider registry to route through. Declare
   an `llm-judge` guardrail with a rubric instead.

4. **Not declaring `configSchema`.** Without it, `config` is
   `Record<string, unknown>` — no validation, no editor completion,
   silent typos. Prefer Zod for TS-side inference on
   `evaluate(config, ...)`.

5. **Ignoring the `Result` from `defineGuardrail`.** It returns
   `Result<Guardrail, …>`; check `kind` and throw at load time.
   `defineCheck` itself throws when its `configSchema` can't be
   compiled.

## References

- Type surface: hover any `@kindgi/sdk/define` export for full JSDoc;
  `Guardrail`, `defineGuardrail` and the built-in checks are in
  `@kindgi/guardrails`.
- API reference: https://docs.kindgi.com/v0.1/reference/typescript/sdk/kindgi/sdk/define/
- Built-in check implementations: `packages/guardrails/src/checks.ts`.

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/sdk` itself
(guardrail runtime dropping context fields, check-sandbox dispatch
regression, misleading error message, CLI friction) — not in the
pack's own code — load the `kindgi-framework-feedback` skill and file
a structured report with `kindgi feedback write`. That diagnostic is
high-signal input the maintainers can act on; don't let it disappear
into the transcript.
