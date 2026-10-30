# Imperative handler

```ts
// tools/verify-citation/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

const Input = z.object({
  citation: z.string().min(1),
  jurisdiction: z.enum(['US', 'UK', 'EU']),
});

const Output = z.object({
  found: z.boolean(),
  canonicalCite: z.string().optional(),
});

const defined = defineTool({
  id: 'acme.verify-citation' as ToolId,
  description:
    'Verify a legal citation against the jurisdictional citator. Returns whether the citation resolves and the canonical form.',
  version: '0.1.0',
  input: Input,
  output: Output,
  effects: [],
  mutating: false,
  handler: async (input, ctx) => {
    // ctx.tenantId, ctx.abortSignal, ctx.secrets (what needsSpec declares) available;
    // in a run, ctx.projectId and ctx.orgId (set from the run, never from the input)
    // Return type MUST match Output schema (validated at invoke time)
    return { found: true, canonicalCite: '...' };
  },
});

if (defined.kind === 'err') {
  throw new Error(`acme.verify-citation failed to compile: ${defined.error.message}`);
}

export default defined.value;
```

A handler must return a Promise; one with nothing to `await` can return `Promise.resolve({ … })` instead of being `async`, which keeps lint rules like `require-await` quiet.

## What the handler receives

The handler gets the **parsed** input, typed `z.infer` of `input` (Zod's output type):

- **Defaults.** A `.default()` field is optional to the caller, the model included. The tool's advertised schema doesn't list it as required, and the handler always gets a value.
- **Transforms and refinements.** `.transform()` results and `.refine()` checks apply before the handler runs. A failed refinement comes back as `input-validation-failed`.
- **Extra keys.** A plain `z.object` accepts them and strips them. Use `z.strictObject` to reject them.
- **JSON-Schema-authored tools** get each property's `default` filled in the same way.
- **Unions of scalars** (`z.union([z.string(), z.number()])`, `type: ['string', 'number']` on the wire) compile and validate. A schema Kindgi's strict schema check still refuses (an open tuple, an unknown keyword) says so at `defineTool`; for a field that may hold any JSON value, `z.json()` compiles.

The output side is the reverse: the advertised output schema requires every field, defaulted ones included. Return them all.

## Logging from the handler

`ctx.log` is a logger bound to the call: its records carry the run's ids, the tool's id and the trace id. It has `info`, `warn`, `error`, `debug` and `trace`, each `(message, fields?)`. The pack service sets it; a context your own code builds (a test's) may not, so write `ctx.log?.`:

```ts
ctx.log?.info('refund issued', { orderId, amountCents });
```

Put values in `fields`, never in the message. Log ids, amounts and outcomes, never what a person typed (a refund's reason, a message, an address): the log is read by whoever operates the runtime, not only by the person the data is about. Docs: https://docs.kindgi.com/v0.3/guides/tools/write-a-tool/#log-from-a-tool
