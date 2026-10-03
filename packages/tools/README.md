# @kindgi/tools

Author, register, and invoke tools for Kindgi. A tool is a typed, effect-declared unit of work — the same definition runs in-process for one flow, over MCP for another. See `@kindgi/specs/tool.schema.json` for the wire contract.

## Schema authoring surfaces

Tools declare their `input` and `output` shapes as **either** JSON Schema Draft 2020-12 objects **or** Zod v4 schemas. The wire form is always JSON Schema — Zod authoring is TS-user sugar the framework converts at author time via `z.toJSONSchema()`.

### Authoring with JSON Schema

The wire form, portable to Python / Go / Rust pack authors publishing over MCP.

```ts
import { defineTool } from '@kindgi/tools';

const echo = defineTool({
  id: 'demo.echo' as never,
  description: 'Echo the input as output.',
  input: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { msg: { type: 'string' } },
    required: ['msg'],
  },
  handler: async (input) => {
    // JSON Schema authoring: input defaults to `unknown` at the type level.
    // Cast at the boundary — Ajv already validated the shape at invoke time.
    const { msg } = input as { msg: string };
    return { msg };
  },
});
```

### Authoring with Zod v4

TS-first ergonomics. The framework converts to JSON Schema at author time, caches the wire form on `tool.input` / `tool.output`, and preserves the original Zod schemas on `tool.inputZod` / `tool.outputZod` so callers can `z.infer<typeof tool.inputZod>` for static types.

```ts
import { defineTool } from '@kindgi/tools';
import { z } from 'zod';

const InputSchema = z.object({ msg: z.string() });
const OutputSchema = z.object({ msg: z.string(), length: z.number().int() });

const echo = defineTool({
  id: 'demo.echo' as never,
  description: 'Echo the input with a length count (Zod-authored).',
  input: InputSchema,
  output: OutputSchema,
  handler: async (input) => {
    // Zod authoring: handler input type is `{ msg: string }` — no cast needed.
    return { msg: input.msg, length: input.msg.length };
  },
});

// Downstream inference (e.g., a wrapper that types calls by tool id):
type EchoInput = z.infer<typeof echo.value.inputZod>; // { msg: string }
```

### When to pick which

Prefer **JSON Schema** when:

- You publish the tool over MCP and expect non-TS consumers.
- The manifest is machine-generated (adapter code, MCP client discovery).
- You want to hand-tune JSON Schema keywords (`format`, `pattern`, `contentMediaType`) with maximum fidelity.

Prefer **Zod** when:

- You author the tool in a TS package and want typed handlers without a duplicate `type` declaration.
- You already validate other parts of your code with Zod and want a single source of truth.
- Runtime + compile-time contract come from the same object.

Both are supported. Mixing is fine (Zod input, JSON Schema output, or vice versa).

## Peer dependency

`zod` (>= 4.0.0) is a peer dependency. Workspaces that never author with Zod never install it and never pay any resolution cost. If you pass a Zod schema without `zod` installed, `defineTool` returns a typed `invalid-schema` error via the `Result` — no module-resolution crash.

## Related

- `packages/schema/SPEC.md` — §"Zod as optional authoring surface" for the primitive layer.
- `packages/guardrails/README.md` — mirrors this pattern for check registration.
