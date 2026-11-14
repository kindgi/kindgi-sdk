# Testing a declaration, and changing a guardrail

## Validating a declaration in-process

`validateGuardrail(spec, checks)` from `@kindgi/guardrails` validates a
`Guardrail` against the wire schema and a check registry: the check id
must be registered, the check's `kind` must match, `config` must pass
the check's config schema, and `at` must be one of the check's points
(the problem at `/at`). `escalate` and `compensate` must be at the final
answer, and `scope.tools` at a tool point. It returns a `Result`; use it
in tests or wherever guardrails are registered in-process. A pack from
`kindgi init` reaches `@kindgi/guardrails` only through `@kindgi/sdk`:
add it as a devDependency, at the version of `@kindgi/sdk`, to import
it in tests.

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

An `llm-judge` guardrail's check is never called, but `validateGuardrail`
still needs one registered under its `check` id, with `kind: 'llm-judge'`:
register the pass-only check its file ships.

Registering a guardrail through the API (`POST /v1/guardrails`, or
`client.guardrails.author(spec, { projectId })` in `@kindgi/sdk/client`)
stores the declaration only; the check it names must already be
available to the runtime that evaluates it.

## Changing a guardrail

Guardrails have no `version` field; the id is the stable identifier.
Changing a guardrail's check, config, severity or action changes
behavior for every agent that references it. When you tighten a rule
(raise severity from `warn` to `error`, switch the action from
`log-only` to `halt`), check whether the agents that reference it are
ready for the stricter enforcement.
