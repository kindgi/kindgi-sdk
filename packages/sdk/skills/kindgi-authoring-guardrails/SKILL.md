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
version: "0.4.1"
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

## What a guardrail can do in 0.1

Read this before you plan a guardrail. These decide what can be built:

- **`halt` and `retry` act.** At the final answer, a failed `halt`
  guardrail fails the turn with `guardrail-violation`, and the response is
  not stored. A failed `retry` guardrail sends the answer back to the
  model, with the check's reason in a user message, for a new one; the
  failed answer isn't stored. When it has failed `retry.maxAttempts`
  answers (the first one included; 2 when left out), the turn fails with
  `guardrail-violation` and `details.attempts`. Each new answer is a model
  call that the agent's `budget.maxSteps` counts. With a `retry` guardrail
  at the final answer, the `halt` and `retry` guardrails there judge each
  answer, a judge's calls included, which `budget.maxCostUsd` doesn't
  count; the others judge only the answer that's sent. A new answer can
  call tools again, side-effecting ones included, with approvals as usual.
  `escalate` and `compensate` are recorded on the turn's violations, as
  `log-only` is, and the turn completes: nothing escalates or calls a
  compensating tool. So "block the reply and make the agent try again" is
  a `retry` guardrail.
- **They act in the loop too.** At `'before-tool'` (after the call's
  access check, before any approval is asked), `halt` fails the turn and
  `retry` refuses the call: it doesn't run, and the model gets the reason
  as its result. At `'after-tool'`, `retry` withholds the result: the
  reason is stored as the call's result in its place, so neither the model
  nor a later turn's history sees it; a replay's recorded result is judged
  as a live one is. At `'model-step'`, `retry` sends the reply back: none
  of its calls runs, nothing of it is stored, and the model writes a new
  reply. `retry.maxAttempts` counts replies across the turn: each reply
  the guardrail sent back, or one with a call it refused or a result it
  withheld, counts once, so two calls of one reply that it refuses are one
  attempt. When they run out, or the turn has no steps left, the turn
  fails with `attempts`, the replies there were. A tool's own result never
  counts as one. A `log-only` failure joins the turn's `violations`. A
  dry run skips the model call, so no guardrail runs at these points in
  one.
  `escalate` and `compensate` are refused away from the final answer
  (by `kindgi build`, `deployment-validation-failed` on deploy,
  `400 validation-failed` on register). A failure names `details.point` and, at a tool point,
  `details.callId`. A resumed turn reuses each point's recorded outcome:
  no judge is asked or billed twice.
- **A check sees one turn.** The trace holds the current turn only: its
  user message (`trace.userInput`), its tool calls and their results
  (`trace.toolCalls`, `trace.toolResults`) and its response
  (`trace.output`, at the final answer only). Earlier turns' messages,
  tool results and responses aren't in it. A check that every figure in
  the response comes from a tool result or the user's message therefore
  blocks a response that repeats a figure seen only in an earlier turn.
- **A check's in-memory state doesn't last.** The check runs in the pack
  service's process, so anything it keeps at module level (say, a record
  per `trace.conversationId`) is lost when that process is replaced: under
  `kindgi dev`, on every reload after a save and on a restart; in a
  deployment, whenever an instance stops. With more than one instance,
  each keeps its own copy, and one conversation's turns can land on
  different instances. Don't keep a conversation's history this way.

What works today for a check on figures: tell the agent, in its
instructions, to call its tools again in every response that quotes a
figure, so the figure is in that turn's tool results. It depends on the
model following the instruction, and it doesn't cover figures the user
typed in an earlier turn: `trace.userInput` is only the current turn's
message, so a response that repeats them is still blocked.

## Mental model: guardrail vs check

- **Check** — the implementation. `defineCheck({ id, kind, points?,
  configSchema?, evaluate })` from `@kindgi/sdk/define` returns a
  registered check whose `evaluate(config, trace, bindings)` resolves to
  `{ passed, reason? }`. Zero-llm checks are pure over the trace. `points`
  names where it can run, from `'before-tool'`, `'after-tool'`,
  `'model-step'` and `'final-answer'`; left out, it's `['final-answer']`.
  An empty list, an unknown point or one named twice throws
  `invalid-check-definition`. A check that reads `trace.output` runs at
  the final answer; one that reads `trace.call`, `trace.result` or
  `trace.step` names the points where they're set.
- **Guardrail** — the declaration: `id`, `kind`, the `check` it uses,
  the check's `config`, `at`, and `action` / `severity` / `scope`. Its type is `Guardrail` from `@kindgi/guardrails`. One check
  can back many guardrails with different configs, each at one of the
  check's points.
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
  `kind`, `action`, `severity`, `scope`, `at`, `sees`, `budget`,
  `judgeCapabilities`, `sandbox` / `limits` / `network`, and the check: its id (`check` may be the check
  id as a string, or the check object), its points (`checkPoints`, for a
  check the module ships) and its config schema (from the check's
  `configZod`, `configSchema` or `configJsonSchema`, or a top-level
  `configZod` / `configSchema`), and the declaration's `config` — what
  the check runs with. It does not record `description`. It checks `config` (none counts as `{}`) against
  the config schema: a config that doesn't fit, or a required field with
  no default left out, is a file error naming where, and `kindgi build`
  refuses the pack. It also refuses an `llm-judge` guardrail with no
  `judgeCapabilities` (the runtime would refuse it on every turn), an
  `at` it doesn't know, a malformed
  `scope.tools` or `points`, what a point can't do in the deploy's paths
  and words (`guardrail <id>: /action/on-violation: "escalate" is
  recorded at the final answer only, not at "before-tool"`, and
  `/scope/tools` for `scope.tools` away from the tool points), and an
  `at` the module's check doesn't run at (`guardrail <id> runs at
  'before-tool', which isn't one of its check's points (final-answer)`).
  A built-in named as a string isn't checked there: deploy refuses one at
  a point it doesn't run at (at `/at`, `deployment-validation-failed`),
  and registering answers `422 guardrail-config-invalid`; registering
  answers `400 validation-failed` for what a point can't do.
- The **pack service** loads the same module to run the check. It uses
  the module's `evaluate` export, or the `default` / `check` export when
  that is a function or has an `evaluate` method — here, the named
  `check` export. A `defineCheck` check's `evaluate` gets the config its
  schema resolves: the schema's defaults applied (a guardrail that
  declares no config gets them all), and a config that doesn't fit
  refused, naming where.

## A guardrail in the agent loop

```ts
// guardrails/refund-limit/index.ts
import { defineCheck } from '@kindgi/sdk/define';
import { z } from 'zod';

export const check = defineCheck({
  id: 'acme.checks.refund-limit',
  kind: 'zero-llm',
  points: ['before-tool'],
  configSchema: z.object({ maxAmount: z.number().positive().default(100) }),
  evaluate: async (config, trace) => {
    // At 'before-tool', trace.call is the call it judges; trace.toolCalls
    // holds only the calls that ran, never this one.
    const amount = trace.call?.arguments.amount;
    if (typeof amount === 'number' && amount > config.maxAmount) {
      return { passed: false, reason: `The refund is ${amount}; the limit is ${config.maxAmount}.` };
    }
    return { passed: true };
  },
});

export default {
  id: 'acme.refund-limit',
  kind: 'zero-llm',
  check,
  at: 'before-tool',
  scope: { tools: ['acme.orders.refund'] },
  action: { 'on-violation': 'retry' },
  severity: 'error',
};
```

What the trace holds at each point:

- `trace.at` — the point. Absent at the final answer.
- `trace.call` — at `'before-tool'` and `'after-tool'`:
  `{ callId, toolId, toolName, toolVersion?, arguments }`.
- `trace.result` — at `'after-tool'`: `{ output }`, or
  `{ error: { code?, message } }` when the call threw.
- `trace.step` — at `'model-step'`: `{ text, toolCalls }`; `text` is
  empty when the reply only asks for calls.

Away from the final answer there's no `trace.output`, and `toolCalls` /
`toolResults` hold only the calls that ran. At the final answer the
trace holds every call the model asked for. A failed `halt` at a loop
point reads
`Turn blocked by guardrail 'acme.refund-limit' before calling acme.orders.refund: …`
(`after <tool> ran`, `on a model reply`; out of attempts,
`…, after 2 replies: …`).

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
`acme.fetch-precedent`; a setting without `?` is required):

| Check | Fails when | `config` |
| --- | --- | --- |
| `must-cite` | the answer is empty, or has fewer than `minCitations` matches of `sourcePattern` | `minCitations?: integer ≥ 1` (1), `sourcePattern?: string` (a regex; `[…]`-style citations by default) |
| `never-call-tool` | the turn called any tool in `tools` | `tools: (string \| { id, version? })[]`, one or more |
| `max-tool-calls` | the turn made more than `max` tool calls | `max?: integer ≥ 0` (10) |
| `output-matches` | the answer doesn't match `pattern` (with `negate: true`, it does) | `pattern: string` (a regex), `flags?: string` (letters `dgimsuyv`), `negate?: boolean` |
| `tool-order` | the tools in `sequence` weren't called in that order (others may come between) | `sequence: string[]`, one or more |
| `required-substring` | the answer is empty, or lacks any of `patterns` | `patterns: string[]`, one or more non-empty (plain text), `caseSensitive?: boolean` (false) |
| `forbidden-substring` | the answer contains any of `patterns` | `patterns: string[]`, one or more non-empty (plain text), `caseSensitive?: boolean` (false) |

Where each runs (the guardrail's `at`): `must-cite` and
`required-substring` at `'final-answer'` only. `never-call-tool`,
`max-tool-calls` and `tool-order` at `'before-tool'` too, judging that
call against the turn's earlier calls, so a call they fail never runs.
`output-matches` and `forbidden-substring` at `'model-step'` and
`'after-tool'` too: they read the reply's text, or the call's result (a
string as it is, anything else as JSON, an error's message). A reply that
only asks for calls has no text and passes `output-matches`.

A config the check doesn't take is refused: a required setting left out,
the wrong type, a setting the check doesn't know, or a regex that doesn't
compile. Registering it answers `422 guardrail-config-invalid` (each
problem in `details.issues`); deploying a pack with one fails with
`deployment-validation-failed`; one that still reaches a turn is a check
that can't run (`invalid-check-config`), so a `halt` guardrail stops the
turn. Each built-in's JSON Schema is its registered check's
`configSchema`.

## Validating a declaration in-process

`validateGuardrail(spec, checks)` from `@kindgi/guardrails` validates a
`Guardrail` against the wire schema and a check registry: the check id
must be registered, the check's `kind` must match, `config` must pass
the check's config schema, and `at` must be one of the check's points
(the problem at `/at`). `escalate` and `compensate` must be at the final
answer, and `scope.tools` at a tool point. It returns a `Result`; use it
in tests or wherever guardrails are registered in-process.

```ts
import { createCheckRegistry, validateGuardrail } from '@kindgi/guardrails';
import type { GuardrailId } from '@kindgi/sdk/types';

import { check } from './index.js';

const checks = createCheckRegistry([check]); // built-in checks are included
const validated = validateGuardrail(
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
if (validated.kind === 'err') {
  throw new Error(`acme.no-fabricated-quotes: ${validated.error.message}`);
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
  `configSchema`: by `validateGuardrail`, and in a pack when the pack is
  indexed (a config that doesn't fit is a file error naming where, and
  `kindgi build` refuses the pack; see "How the pack tooling reads this
  file"). In a pack, the declaration's `config` goes into the index and
  the check runs with it; without one it runs with `{}`. A `defineCheck`
  check's `evaluate` receives the config its schema resolves, with the
  schema's defaults applied; a check written without `defineCheck` gets
  the config as declared.
- **`at`** — where in the turn it runs: `'final-answer'` (the default),
  `'before-tool'`, `'after-tool'` or `'model-step'`. It must be one of
  its check's `points`. At a tool point or a model reply, a check that
  can't run (a point its check doesn't run at as
  `check-point-unsupported`, or its time ran out as `check-timed-out`)
  acts as a failed one: `halt` fails the turn, `retry` refuses, withholds
  or sends back with the reason `its check couldn't run (<code>): <message>`.
  A check that isn't registered counts there as one that runs at the final
  answer only, so it fails as `check-point-unsupported`, saying no check by
  that name is registered; at the final answer it's `unknown-check`. At the
  final answer, a `retry` whose check can't run goes on as if it passed.
- **`action.on-violation`** — `'halt'`, `'retry'` (with `retry.maxAttempts`,
  1–10), `'escalate'` (with `escalateTo`), `'log-only'`, `'compensate'`
  (with `compensateWith`, a tool id). In an agent turn, a failed `halt`
  guardrail fails the turn with `guardrail-violation` and the response is
  not stored; a failed `retry` guardrail sends the answer back for a new
  one, or at a loop point refuses the call, withholds its result or sends
  the reply back (above); failures with any other action are reported in
  `AgentTurnResult.violations` and the turn completes. The action handlers
  in `@kindgi/guardrails` (`retryHandler`, `escalateHandler`,
  `compensateHandler`, …) record the intent for callers that act on it.
  `escalate` and `compensate` are recorded on the violation, with no
  escalation or compensating call in 0.1.
- **`severity`** — `'info'` / `'warn'` / `'error'` (the default) /
  `'critical'`. Orthogonal to `action`: logs and dashboards group by
  severity; execution follows the action. A `log-only` guardrail can
  still be `'critical'`.
- **`scope`** — when the guardrail applies. `{ when: 'always' }` fires
  everywhere; `{ when: 'ci-only' }` blocks CI but not runtime;
  `{ when: 'runtime-only' }` enforces at runtime but not CI. `agents`,
  `flows` and `tenants` lists narrow it further. `tools`, only at
  `'before-tool'` and `'after-tool'`, lists the tool ids it checks; a
  trailing `*` matches every id with that prefix (`'acme.crm.*'`), a `*`
  anywhere else or an empty list is refused, and left out it checks every
  tool.
- **`budget`** — `{ maxCostUsd?, maxLatencyMs? }`. The agent loop
  enforces `maxLatencyMs` before a tool call, after it and on each model
  reply (`at`), with a default per kind when it's absent (10 s
  `zero-llm`, 60 s `llm-judge`, 30 s any other); a check that runs past
  it fails as one that couldn't run (`check-timed-out`), handled by the
  guardrail's action. It isn't enforced at the final answer, and
  `maxCostUsd` isn't enforced.
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
  budget: { maxCostUsd: 0.01, maxLatencyMs: 5000 }, // maxLatencyMs: enforced at the loop's points only
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

5. **Ignoring the `Result` from `validateGuardrail`.** It returns
   `Result<Guardrail, …>`; check `kind` and throw at load time.
   `defineCheck` itself throws when its `configSchema` can't be
   compiled.

## References

- Type surface: hover any `@kindgi/sdk/define` export for full JSDoc;
  `Guardrail`, `validateGuardrail` and the built-in checks are in
  `@kindgi/guardrails`.
- API reference: https://docs.kindgi.com/v0.3/reference/typescript/sdk/kindgi/sdk/define/
- Built-in check implementations: `packages/guardrails/src/checks.ts`.

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/sdk` itself
(guardrail runtime dropping context fields, check-sandbox dispatch
regression, misleading error message, CLI friction) — not in the
pack's own code — load the `kindgi-framework-feedback` skill and file
a structured report with `kindgi feedback write`. That diagnostic is
high-signal input the maintainers can act on; don't let it disappear
into the transcript.
