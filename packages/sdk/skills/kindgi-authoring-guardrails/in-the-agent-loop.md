# A guardrail in the agent loop

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

A check that reads `trace.output` runs at the final answer; one that
reads `trace.call`, `trace.result` or `trace.step` names the points where
they're set in `defineCheck`'s `points`. An empty list, an unknown point
or one named twice throws `invalid-check-definition`.

Away from the final answer there's no `trace.output`, and `toolCalls` /
`toolResults` hold only the calls that ran. At the final answer the
trace holds every call the model asked for. A failed `halt` at a loop
point reads
`Turn blocked by guardrail 'acme.refund-limit' before calling acme.orders.refund: …`
(`after <tool> ran`, `on a model reply`; out of attempts,
`…, after 2 replies: …`).
