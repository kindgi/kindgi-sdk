# Using a built-in check

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
