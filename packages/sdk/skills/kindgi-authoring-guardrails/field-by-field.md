# Field-by-field

- **`id`** — `<pack-id>.<guardrail-name>` (kebab-case, dot-namespaced).
  Name the ASSERTION as a positive rule (e.g. `no-fabricated-quotes`,
  `response-not-empty`, `must-cite-source`).
- **`kind`**:
  - `'zero-llm'` — pure function over the trace. Fast, deterministic,
    free. **The default choice for most safety rules.**
  - `'llm-judge'` — a model scores the turn against a rubric. Costs
    money; requires `judgeCapabilities`.
  - `'external'` — evaluated outside the engine. The built-in
    `external` strategy returns an `invalid-guardrail` error; a caller
    that wants external evaluation registers its own strategy.
- **`check`** — the id of a registered check (built-in, or one built
  with `defineCheck`). In a pack file it may also be the check object.
- **`config`** — the check's parameters, validated against the check's
  `configSchema`: by `validateGuardrail`, and in a pack when the pack is
  indexed (a config that doesn't fit is a file error naming where, and
  `kindgi build` refuses the pack). In a pack, the declaration's `config` goes into the index and
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
- **`action.on-violation`** — `'halt'`, `'retry'` (with `action.retry`),
  `'escalate'` (with `escalateTo`), `'log-only'`, `'compensate'`
  (with `compensateWith`, a tool id). In an agent turn, a failed `halt`
  guardrail fails the turn with `guardrail-violation` and the response is
  not stored; a failed `retry` guardrail sends the answer back for a new
  one, or at a loop point refuses the call, withholds its result or sends
  the reply back; failures with any other action are reported in
  `AgentTurnResult.violations` and the turn completes. The action handlers
  in `@kindgi/guardrails` (`retryHandler`, `escalateHandler`,
  `compensateHandler`, …) record the intent for callers that act on it.
  `escalate` and `compensate` are recorded on the violation, with no
  escalation or compensating call in 0.1.
- **`action.retry`** — `{ maxAttempts }`, 1–10, beside `on-violation`:
  `action: { 'on-violation': 'retry', retry: { maxAttempts: 3 } }`. It
  counts what the guardrail fails in a turn, the first one included, so
  3 sends back, refuses or withholds up to twice. Left out, 2.
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
