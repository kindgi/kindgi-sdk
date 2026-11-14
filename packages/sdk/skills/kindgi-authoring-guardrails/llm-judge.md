# LLM-judge guardrail (costs money)

An `llm-judge` guardrail does not run custom check code: the engine's
`llm-judge` strategy sends the turn's trace and the rubric in `config`
(`{ rubric, responseFormat?, threshold?, temperature? }`) to a model
routed through `judgeCapabilities`, and parses a PASS/FAIL or a score.
`kindgi build` refuses one with no `judgeCapabilities`.

```ts
// guardrails/tone-professional/index.ts
import { defineCheck } from '@kindgi/sdk/define';

// Every guardrail names a check. The llm-judge strategy judges with
// `config` and never calls this one, so it only passes.
export const check = defineCheck({
  id: 'acme.checks.tone-professional',
  kind: 'llm-judge',
  evaluate: async () => ({ passed: true }),
});

// The guardrail declaration the indexer reads: the default export.
export default {
  id: 'acme.tone-professional',
  name: 'Professional tone',
  kind: 'llm-judge',
  check,
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

A test that validates it with `validateGuardrail` registers this same
check (`createCheckRegistry([check])`, with `check: check.id` in the
spec): the check the guardrail names must be registered, with the same
`kind`, or it's `unknown-check` (a kind that differs is
`invalid-guardrail` at `/kind`). A check with no `configSchema` takes any
`config`.

The judge is resolved from the provider registry passed in the
evaluation bindings (or a pinned `judgeProvider`), under the workspace
policy in those bindings, if any. Checks that run in a pack are called with empty
`bindings` — no provider registry — so a pack check cannot call a model
itself; use `kind: 'llm-judge'` for model-based rules.
