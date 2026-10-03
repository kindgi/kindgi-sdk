# @kindgi/guardrails

Runtime + CI enforcement of agent-behavior guardrails for Kindgi. Every declared guardrail references a **check** (built-in or custom) that decides whether the run trace passes. `evaluateGuardrail` / `evaluateAll` run guardrails against a `RunTrace`, dispatching each `kind` through an execution-strategy registry (`zero-llm`, `llm-judge`, `external` built in). See `@kindgi/specs/guardrail.schema.json` for the wire contract.

## Schema authoring for custom checks

Custom checks accept an optional `configSchema` — **either** a JSON Schema Draft 2020-12 object **or** a Zod v4 schema. When set, `defineCheck` derives the check's `validateConfig` function from the schema so authors don't repeat themselves. The wire form of a guardrail's `config` stays a plain JSON object; Zod is TS-user sugar that `defineCheck` converts when the check is defined.

### JSON Schema authoring

```ts
import { defineCheck, createCheckRegistry } from '@kindgi/guardrails';

const maxCitations = defineCheck({
  id: 'demo.max-citations',
  kind: 'zero-llm',
  configSchema: {
    type: 'object',
    properties: { max: { type: 'integer', minimum: 1 } },
    required: ['max'],
    additionalProperties: false,
  },
  evaluate: async (config, trace) => {
    const max = (config as { max: number }).max;
    const matches = (trace.output ?? '').match(/\[[^\]]+\]/g) ?? [];
    return matches.length <= max
      ? { passed: true }
      : { passed: false, reason: `too many citations (${matches.length} > ${max})` };
  },
});

const registry = createCheckRegistry([maxCitations]);
```

### Zod v4 authoring

```ts
import { defineCheck, createCheckRegistry } from '@kindgi/guardrails';
import { z } from 'zod';

const ConfigSchema = z.object({
  max: z.number().int().min(1),
  pattern: z.string().optional(),
});

const maxCitations = defineCheck({
  id: 'demo.max-citations',
  kind: 'zero-llm',
  configSchema: ConfigSchema,
  evaluate: async (config, trace) => {
    // config is typed as z.infer<typeof ConfigSchema> — no cast needed.
    const re = new RegExp(config.pattern ?? '\\[[^\\]]+\\]', 'g');
    const matches = (trace.output ?? '').match(re) ?? [];
    return matches.length <= config.max
      ? { passed: true }
      : { passed: false, reason: `too many citations (${matches.length} > ${config.max})` };
  },
});

// Static type of the derived config:
type Config = z.infer<typeof maxCitations.configZod>;
// -> { max: number; pattern?: string }
```

### When to pick which

Same trade-off as `@kindgi/tools`: JSON Schema for portable / MCP-published checks, Zod for TS-first authoring with `z.infer` derivation. Both coexist; you can also leave `configSchema` off entirely and supply a hand-written `validateConfig`.

## The `Guardrail` wire shape

Note that `Guardrail.config` on the wire is always `object` with `additionalProperties: true` — the check declares the concrete schema. Authors extend the guardrail registration surface (`defineCheck`); the guardrail surface itself takes an opaque `config` payload that the resolved check validates when `defineGuardrail` runs.

## Peer dependency

`zod` (>= 4.0.0) is a peer dependency. Workspaces that never author with Zod never install it. Zod schemas that fail to convert (unrepresentable constructs like `z.function()`) surface as `invalid-check-definition` thrown at pack init — same failure model as an uncompilable JSON Schema.

## Related

- `packages/schema/SPEC.md` — §"Zod as optional authoring surface".
- `packages/tools/README.md` — the mirror pattern for tool authoring.
