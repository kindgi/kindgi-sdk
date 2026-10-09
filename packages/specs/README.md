# @kindgi/specs

**Protocol layer. Source of truth. Human-authored, machine-consumable.**

Every artifact kind in Kindgi has its shape defined here as a JSON Schema
(Draft 2020-12). Package implementations derive their types from these
schemas — never the other way around. SDKs, runtimes, and external tools
(Python, Go, community MCP tools) validate and generate against the same
files.

## Usage

Resolve a single schema by name — `@kindgi/specs/<name>.schema.json`:

```ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const flowSchema = JSON.parse(
  readFileSync(require.resolve('@kindgi/specs/flow.schema.json'), 'utf8'),
);
```

Example fixtures resolve the same way:
`@kindgi/specs/examples/flow.example.with-loop.json`.

To enumerate the whole set (spec registries, validators, codegen), use the
directory exports:

| Export | Kind | Description |
|---|---|---|
| `SPECS_SCHEMAS_DIR` | `string` | Absolute path to the directory holding every `<name>.schema.json`. |
| `SPECS_EXAMPLES_DIR` | `string` | Absolute path to the example fixtures (`<schema-name>.example.<label>.json`). |

Schemas reference each other by `$id` (e.g. `pack.schema.json` →
`tool.schema.json`), so register the whole set before compiling one — see
`@kindgi/schema`.

## Schemas

| Schema | Purpose |
|---|---|
| `agent.schema.json` | Agent — instructions + capabilities + tools + memory, declaratively composed |
| `audit-bundle.schema.json` | Audit bundle — the signed body of an approval's audit bundle: who decided, when, why, and the evidence |
| `capability.schema.json` | Capability declaration — model requirements as constraints |
| `compliance-evidence.schema.json` | Compliance evidence record emitted by the runtime |
| `discoverable.schema.json` | Discoverable entity marker — cross-history retrieval |
| `eval-suite.schema.json` | Evaluation suite — subject invoker + case set |
| `event.schema.json` | Event — the causal glue between runs |
| `flow.schema.json` | Task flow — nodes, edges, data mapping, versioning |
| `guardrail.schema.json` | Guardrail declaration — runtime + CI enforcement gates |
| `memory.schema.json` | Log entries + facts — the two memory primitives |
| `pack.schema.json` | Pack manifest — installable vertical application |
| `pack-index.schema.json` | Pack index — the `index.json` a pack build emits; what a runtime registers and a pack service loads |
| `pack-protocol.schema.json` | Pack protocol v2 — the messages a runtime exchanges with a pack service (any language) |
| `policy.schema.json` | Tenant policy — access control and scope rules |
| `provenance.schema.json` | Causal DAG — signed, portable, verifiable outside the runtime |
| `run-event.schema.json` | Kernel run lifecycle events (SSE stream) |
| `signed-export.schema.json` | Signed export — the envelope of every signed export (audit bundle, provenance, compliance evidence): the signed bytes, the signature, the key |
| `tool.schema.json` | Tool definition — MCP-compatible, transport-agnostic |

## Rules

1. **Every schema uses Draft 2020-12** (`$schema: "https://json-schema.org/draft/2020-12/schema"`).
2. **Every schema has a versioned `$id`** — `https://kindgi.com/schemas/v<N>/<name>.schema.json`. The `<name>` segment must exactly match the filename base. Enforced by `scripts/validate.mjs`.
3. **Every schema carries `$comment: "schema-version: X.Y.Z"`** with full semver. Human-readable, non-validating annotation. Also enforced.
4. **`additionalProperties: false`** on every object node unless there's a documented reason to allow open-ended keys.
5. **Descriptions are load-bearing** — they're what AI codegen and human readers use to understand intent. Write them like production API docs.
6. **`$defs` for reusable sub-shapes** — never inline the same shape twice.
7. **Examples live under `examples/<schema-name>.example.<label>.json`** — validated in CI by `scripts/validate.mjs`.

## Versioning policy

Schemas are wire contracts. Four notions of version are distinct:

| Version of | Where | Example |
|---|---|---|
| The artifact instance | Inside the artifact (`.version` field) | `flow.version = "1.2.3"` |
| The schema itself | `$id` path segment + `$comment` | `.../v1/flow.schema.json` + `schema-version: 1.0.0` |
| The JSON Schema draft | `$schema` | `.../draft/2020-12/schema` |
| This package | `package.json` `version` (shared by every `@kindgi/*` package) | `@kindgi/specs@0.1.0` |

### When to bump what

| Change | Bump |
|---|---|
| Wording, description edits, internal `$defs` refactor | none |
| Add an optional field | patch or minor |
| Add a required field with default handling in consumers | minor + migration note |
| Rename a field | **major** — new file, new `$id`, old file archived under `schemas/archive/v<N>/` |
| Remove a field | **major** |
| Widen an enum (add a value) | minor (consumers required to tolerate unknown values) |
| Narrow an enum (remove a value) | **major** |

**Until the first stable release (1.0.0 of the `@kindgi/*` packages)**,
a breaking change — any row marked **major** above — is a **minor**
bump instead: the `$id` keeps its `v<N>` segment, nothing is archived,
and the schema's `description` gets a version-history note
("Schema-version 1.9.0 removes …") saying what changed. The major rows,
with a new `$id` and an archived old file, apply from 1.0.0 on.

### Archived majors

When a schema bumps major (e.g. v1 → v2), the v1 file moves to
`schemas/archive/v1/<name>.schema.json` and stays there indefinitely. Old artifacts (provenance DAGs, packs, memory rows serialized
under v1) continue to validate. Consumers reference by `$id` — old `$id`s
keep resolving to the archived file.

## Validation

```bash
pnpm run spec:validate      # from the repository root
pnpm run validate           # from this package
```

Validates:
- Every schema compiles under Draft 2020-12.
- Every schema's `$id` matches the versioned URL convention and the filename.
- Every schema carries a valid `$comment: "schema-version: X.Y.Z"`.
- Every example fixture in `examples/` validates against its schema.
- Cross-schema `$ref`s resolve (e.g. `pack.schema.json` referencing `tool.schema.json`).

CI runs this on every PR; broken specs fail the build. Packages that bundle
a copy of a schema for offline validation (`@kindgi/flow`, `@kindgi/tools`,
`@kindgi/capabilities`, `@kindgi/guardrails`, `@kindgi/provenance`, …) keep a drift test that
compares their copy with the one resolved from this package.
