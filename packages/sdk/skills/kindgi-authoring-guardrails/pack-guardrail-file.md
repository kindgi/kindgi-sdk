# A pack guardrail file (zero-llm)

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
