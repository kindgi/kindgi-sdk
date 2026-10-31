---
name: kindgi-authoring-tools
description: >
  Covers writing tools for a Kindgi pack with @kindgi/sdk:
  defining tools via defineTool with either an imperative handler or a
  declarative HTTP spec, choosing between Zod v4 and JSON Schema for
  input/output, tool id naming conventions, handling the Result return
  shape, and how tools reach agents via ToolRef versioning. Load this
  whenever you are authoring or editing code inside a pack's tools/
  directory, defining a tool, or wiring a tool onto an agent. Getting
  started with a new pack is covered by kindgi-getting-started;
  authoring agents is covered by kindgi-authoring-agents.
type: core
library: "@kindgi/sdk"
version: "0.5.2"
sdk_version: "0.0.0"
pack_languages: [node]
sources:
  - packages/tools/src/types.ts
  - packages/tools/src/define.ts
---

# Authoring Kindgi tools

> **Running `kindgi`:** the CLI is a devDependency of the project (`@kindgi/cli`),
> not a global command. Run it through the project's package manager —
> `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm), `yarn kindgi …` or
> `bun run kindgi …`. Commands below are written `kindgi …` for brevity.

A **tool** is a callable unit of work an agent invokes: a function with a
typed input, a typed output, and either author-written logic or a
declarative spec the framework synthesizes into logic. Tools live at
`tools/<name>/index.ts` inside a pack; the pack indexer discovers
them by folder convention.

Before writing a tool, establish what it should DO — its purpose,
inputs, outputs, and whether it extends an existing tool or is fresh.
Requests like "add a tool" without a purpose are conversation openers,
not tickets. Ask what it should compute or fetch, what shape the caller
provides, what shape it returns. The pack's existing tools are examples
that prove the framework runs end-to-end — they are NOT the shape you
imitate unless the user explicitly asks for that.

## Two authoring modes

Both use `defineTool` from `@kindgi/sdk/define`. Pick based on where the
logic lives:

- **`handler`** — imperative TS function. Use when the tool computes,
  transforms, calls a proprietary library, or has non-trivial logic
  that lives in the pack's source.
- **`spec`** — declarative descriptor. Use when the tool is a
  straightforward remote call. `spec: {kind: 'http', ...}` is the kind
  that ships with the framework; other kinds can be added with
  `registerToolSpecSynthesizer`. The framework synthesizes the handler
  from the spec — URL substitution, timeout, abort propagation, secret
  resolution and the status check are handled for you (there is no
  automatic retry).

`handler` and `spec` are MUTUALLY EXCLUSIVE. Setting both (or neither)
makes `defineTool` return an `invalid-tool-definition` error.

## Your case: read this file

| Your case | Read |
|---|---|
| A `handler`: what it gets (`input`, `ctx`), and logging | [imperative-handler.md](imperative-handler.md) |
| An env value, a tenant's secret, or acting in another app (a connection) | [secrets-and-connections.md](secrets-and-connections.md) |
| A plain remote call: `spec: {kind: 'http'}` | [declarative-http.md](declarative-http.md) |
| A read-only tool, a person's yes in unattended runs, results that are outside text | [tool-flags.md](tool-flags.md) |
| Changing a tool, its `version`, its tests, code several tools share | [iterating-and-testing.md](iterating-and-testing.md) |
| An error, or a tool that won't index or load | [common-mistakes.md](common-mistakes.md) |

## Tool id convention

`<pack-id>.<tool-name>` — kebab-case, dot-namespaced. The `<pack-id>`
prefix scopes the tool to its pack; `<tool-name>` names the operation.
Enforced by `defineTool` at author time. Examples:
`acme.verify-citation`, `shop.fetch-order`, `demo.echo`.

## Wiring the tool onto an agent

Agents reference tools via `ToolRef[]`, NOT `string[]`. Each entry is
`{id, version}` where `version` is an npm-style semver **range**:

```ts
// agents/brief-writer/index.ts
tools: [
  { id: 'acme.verify-citation' as ToolId, version: '^0.1.0' },
  { id: 'acme.fetch-precedent' as ToolId, version: '~0.2.0' },
],
```

The resolver picks the highest active version matching the range at
run start via `semver.maxSatisfying`. No implicit `:latest`.

## References

- Type surface: `hover any @kindgi/sdk/define export` in your editor
  for full JSDoc — every field on `DefineToolSpec` / `ToolManifest`
  documents purpose, when to set it, and gotchas.
- API reference: https://docs.kindgi.com/v0.3/reference/typescript/sdk/kindgi/sdk/define/ (every `define*` spec, field by field).
- Common patterns: check the `sample` template (`kindgi init
  --template=sample`) for working examples of both authoring modes.

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/sdk` itself (SDK
type drift, wire schema silently dropping a field, indexer allowlist
gap, misleading error, CLI friction) — not in the pack's own code —
load the `kindgi-framework-feedback` skill and file a structured report
with `kindgi feedback write`. That diagnostic is high-signal input the
maintainers can act on; don't let it disappear into the transcript.
