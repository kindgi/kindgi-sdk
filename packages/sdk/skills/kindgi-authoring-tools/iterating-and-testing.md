# Iterating on a tool, testing it, and shared code

## Iterating on a tool

Edit the source file (`tools/<tool>/index.ts`), save. The next
`kindgi runs start` sees the change — new input/output schema, new
description, new handler behavior. No version bump, no restart, no
re-registration ceremony. Source is truth in dev.

The `version` field is a **semver contract for humans** — it declares
what callers can rely on. Bump it because the *contract with
downstream callers* changed (removed a field, tightened a type,
narrowed enum values), not because you saved the file. If you're
iterating in dev and the shape isn't finalized, leave `version`
alone.

**When version matters:** `kindgi deploy` publishes to a durable
production registry that enforces the immutable `(id, version)`
contract — a re-publish of the same version with different bytes
gets rejected. That's when semver discipline kicks in. The deploy
tooling surfaces the check; you don't have to think about it while
authoring.

**Downstream callers still pin ranges.** An agent's `tools: [{id,
version: '^0.1.0'}]` picks the highest active version matching the
range at run start. Compatible tool updates (patch, minor) reach the
agent without editing agent source; breaking updates (major) require
the agent-author to opt in.

## Testing a tool

Put a tool's tests beside it, `tools/<tool>/index.test.ts`. Discovery skips `*.test.*` and `*.spec.*` files (`.ts`, `.js`, `.mjs`, `.cjs`), so the indexer never loads a test as a primitive: don't move tests elsewhere to keep them out. `invokeTool(tool, input, ctx)` from `@kindgi/sdk/define` calls the tool the way Kindgi does, schemas included, and returns a `Result`. `toolContextForTest()` builds its `ctx` (tenant `tenant-test`, run `run-test`, an abort signal) and takes what to change: `env`, `secrets`, `projectId`.

```ts
import { invokeTool, toolContextForTest } from '@kindgi/sdk/define';

const result = await invokeTool(lookupOrder, { orderId: 'ord_1001' }, toolContextForTest());
// a tool with env values: invokeToolForTest(tool, input, { env: { STORE_URL: '…' } })
```

`kindgi test` runs the pack's tests with vitest (`vitest run`; `--watch` keeps watching). In an app Kindgi was added to, `kindgi init` wrote the vitest config (`vitest.config.mts`, or `.ts` in a `"type": "module"` app): it runs `kindgi/**/*.test.ts`, and its `resolve.alias` copies `tsconfig.json`'s `paths`, which vitest doesn't read. A test that can't resolve an alias the app's code uses (`@/…`) means the two differ: update the config's alias, not the import.

## Shared code

Code several tools share (schemas, a client, helpers) goes outside `tools/`, for example in `lib/` beside it. Discovery loads every `.ts`, `.js` and `.mjs` file under `tools/` (tests aside) as a primitive, so a helper there fails the index. Don't put it in the app's own source either: import the app's functions from where they are (unless their module imports `server-only`: see mistake 12 in `common-mistakes.md`; for a CommonJS package's default import, see mistake 13 in `common-mistakes.md`), and keep what's Kindgi's in the pack's folder.
