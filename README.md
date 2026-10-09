# Kindgi SDK

The public, Apache-2.0 packages for building on [Kindgi](https://kindgi.com):
define agents, tools, flows, and guardrails; author packs; embed the HTTP
API surface; talk to a Kindgi deployment from TypeScript; and write a pack's
tools and guardrail checks in Python.

> **Status: preview.** APIs may change between `0.x` releases. The runtime
> that executes agents and flows ships as a container image, which
> `kindgi dev` runs for you. We are not accepting external contributions
> yet: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Get started

You need Node 22.12 or later and Docker.

```sh
npx @kindgi/cli init my-pack        # a new pack; in an existing app: npx @kindgi/cli init
cd my-pack
pnpm install
pnpm exec kindgi dev                 # npm: npx --no kindgi dev
```

`kindgi dev` runs the Kindgi runtime as a container and your pack's code on
your machine, and picks up every save. `kindgi init` also installs the Claude
Code skills for writing tools, agents, guardrails and flows into
`.claude/skills/`. The [CLI's README](./packages/cli/README.md) covers every
command.

Use the scoped name, `@kindgi/cli`: there is no unscoped `kindgi` package.

**Calling Kindgi from an application:** `@kindgi/sdk` is the one runtime
dependency, with the CLI for development.

```sh
pnpm add @kindgi/sdk
pnpm add -D @kindgi/cli
```

`createClient` and `subscribeToRun` come from `@kindgi/sdk/client`: starting
runs, following their events, and the browser-safe public run tokens.
`verifyWebhook` comes from `@kindgi/sdk/webhooks`, on the server only. See
[`@kindgi/sdk`](./packages/sdk).

**A Python pack:** `npx @kindgi/cli init my-pack --template=python`, or in an
existing Python app `npx @kindgi/cli init`, which adds `kindgi` from PyPI
(`uv add kindgi`, or `pip install kindgi`). See [`kindgi`](./sdks/python).

## Packages

All `@kindgi/*` packages share one version.

<!-- packages:start -->
| Package | Description |
|---|---|
| [`@kindgi/adapter-model-anthropic`](./packages/adapters/model-anthropic) | Anthropic ModelProvider for @kindgi/capabilities. |
| [`@kindgi/adapter-model-gemini`](./packages/adapters/model-gemini) | Gemini ModelProvider for @kindgi/capabilities, on Vertex AI. |
| [`@kindgi/adapter-model-in-process`](./packages/adapters/model-in-process) | In-process ModelProvider for @kindgi/capabilities. |
| [`@kindgi/adapter-model-openai-compat`](./packages/adapters/model-openai-compat) | OpenAI-compatible ModelProvider for @kindgi/capabilities. |
| [`@kindgi/agents`](./packages/agents) | Agent primitive for Kindgi. |
| [`@kindgi/api`](./packages/api) | REST + SSE HTTP surface for Kindgi™. |
| [`@kindgi/audit-events`](./packages/audit-events) | Kindgi™ audit events contract. |
| [`@kindgi/audit-events-inmemory`](./packages/audit-events-inmemory) | Reference in-memory `AuditEventBinding` adapter for dev + tests. |
| [`@kindgi/authz`](./packages/authz) | Kindgi™ authorization shape. |
| [`@kindgi/blob-binding`](./packages/blob-binding) | Kindgi™ blob storage binding contract. |
| [`@kindgi/capabilities`](./packages/capabilities) | Capability declarations + provider router for Kindgi™. |
| [`@kindgi/cli`](./packages/cli) | Command-line interface for Kindgi™ — the sovereign AI OS. |
| [`@kindgi/compliance`](./packages/compliance) | Kindgi™ compliance evidence contract. |
| [`@kindgi/crypto`](./packages/crypto) | Kindgi™ cryptographic primitives. |
| [`@kindgi/dev-echo-provider`](./packages/dev-echo-provider) | Deterministic dev-only ModelProvider — no LLM key, no network, no cost. |
| [`@kindgi/dotenv-file`](./packages/dotenv-file) | Dotenv files the way applications read them (dotenv grammar, verified against the version Next.js bundles), expanded (${VAR}), layered (.env < .env.local) and edited losslessly. |
| [`@kindgi/embedding`](./packages/embedding) | Kindgi™ embedding provider contract and registry: the EmbeddingProvider interface (embed / dimensions / describe), the EmbeddingProviderRegistry interface with the createEmbeddingProviderRegistry in-memory factory, and the EmbeddingError union (NoEmbeddingProviderError, UnknownEmbeddingModelError, DuplicateEmbeddingProviderError, AmbiguousDefaultProviderError). |
| [`@kindgi/env-inmemory`](./packages/env-inmemory) | Reference in-memory `EnvBinding` adapter — dev + tests only; refuses to boot in production. |
| [`@kindgi/env-schema`](./packages/env-schema) | Machine-readable registry of the Kindgi runtime's operator-facing env vars. |
| [`@kindgi/flow`](./packages/flow) | Flow model + predicate DSL for Kindgi™. |
| [`@kindgi/guardrails`](./packages/guardrails) | Runtime + CI enforcement of agent-behavior guardrails for Kindgi. |
| [`@kindgi/handler`](./packages/handler) | Kindgi™ pack-author authoring surface. |
| [`@kindgi/handler-runtime`](./packages/handler-runtime) | Runtime-side primitives for running a Kindgi pack's own code. |
| [`@kindgi/log`](./packages/log) | Kindgi™ structured logging: levels per subsystem (with dotted inheritance), JSON and pretty formats, redaction of secret keys and token shapes, and W3C trace-context helpers. |
| [`@kindgi/memory`](./packages/memory) | Kindgi™ memory type surface. |
| [`@kindgi/pack-conformance`](./packages/pack-conformance) | Conformance suite for pack services: a black-box HTTP and process test of pack protocol v2 and the pack index, run against any language's pack service and indexer over the same fixture pack. |
| [`@kindgi/platform`](./packages/platform) | Multi-tenant hierarchy primitives — the Tenant → Org → Team → Project + User type surface, the `Scope` discriminated access-boundary, binding interfaces for orgs, teams, projects, memberships, team-project grants and the tenant hierarchy, and reference in-memory adapters. |
| [`@kindgi/policy-contract`](./packages/policy-contract) | Kindgi™ policy-contract type surface. |
| [`@kindgi/provenance`](./packages/provenance) | Kindgi™ provenance type surface + pure DAG primitives. |
| [`@kindgi/runtime`](./packages/runtime) | Kindgi™ runtime wire-vocabulary + binding interfaces. |
| [`@kindgi/sandbox`](./packages/sandbox) | Kindgi™ sandbox contract and wire protocol. |
| [`@kindgi/schema`](./packages/schema) | JSON Schema utilities for Kindgi. |
| [`@kindgi/sdk`](./packages/sdk) | @kindgi/sdk — the authoring SDK for Kindgi™. |
| [`@kindgi/secrets-dotenv`](./packages/secrets-dotenv) | Dev-mode `SecretBinding` over the project's own env files (`.env`, then `.env.local`, or `dev.envFiles`) — the same files, parsed the same way, as the app beside the pack — plus the one definition of which env files belong to a pack environment. |
| [`@kindgi/specs`](./packages/specs) | Canonical JSON Schemas (Draft 2020-12) for every Kindgi artifact kind — flow, agent, tool, capability, guardrail, policy, event, run event, memory, provenance, pack, compliance evidence, audit bundle, eval suite, discoverable entity. |
| [`@kindgi/testing`](./packages/testing) | Test helpers for Kindgi apps and packages. |
| [`@kindgi/tools`](./packages/tools) | Tool authoring shape + registry + invocation for Kindgi. |
| [`@kindgi/types`](./packages/types) | Foundational TypeScript types shared across Kindgi. |
| [`@kindgi/client`](./sdks/typescript) | TypeScript client SDK for Kindgi™ — the sovereign AI OS. |
<!-- packages:end -->

## Python

[`kindgi`](./sdks/python) (Python 3.11+, on PyPI: `uv add kindgi`) — a pack's tools and
guardrail checks in Python, with agents and flows as data. Its pack service
speaks the same pack protocol as the Node one, and both pass
[`@kindgi/pack-conformance`](./packages/pack-conformance).

[`kindgi-cli`](./sdks/python-cli) (on PyPI from 0.1.4: `uv add --dev kindgi-cli`) — the
Kindgi CLI for Python developers: `@kindgi/cli` with Node from a wheel, so
`uv run kindgi dev` needs no Node install.

## Java

[`kindgi-client`](./sdks/java) (Java 17+, preview; not on Maven Central yet) — the
Kindgi API from a Java app: generated from the OpenAPI document at build time, with
typed models and errors, paging, streaming and retries. It works beside an app's
own Jackson, Spring Boot 3 and 4 included.

## Specs

[`@kindgi/specs`](./packages/specs) holds the canonical JSON Schemas
(`$id` `https://kindgi.com/schemas/v<N>/<name>.schema.json`) for every
artifact kind, importable by name as `@kindgi/specs/<name>.schema.json`.
The HTTP API is described by the OpenAPI document shipped as
`@kindgi/api/openapi.json`.

## Development

```sh
pnpm install
pnpm run ci
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for rules and the release flow.

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
Security issues: see [SECURITY.md](./SECURITY.md).
