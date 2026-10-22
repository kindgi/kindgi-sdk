---
title: Features by SDK
description: Which features the TypeScript, Python, Java and Scala SDKs have, and what to do where one lacks a feature.
sidebar:
  label: Features by SDK
---

This page shows which features each SDK has, and what to do where your
language's SDK lacks one.

Kindgi has an SDK for TypeScript, Python, Java and Scala. Each one does two
jobs:

- **In a pack:** your tools, guardrails, agents and flows.
- **In your app:** calling Kindgi's API to start runs, follow them, decide
  approvals, and so on.

| | TypeScript | Python | Java | Scala |
| --- | --- | --- | --- | --- |
| Package | `@kindgi/sdk` | `kindgi` | `com.kindgi:kindgi-pack`, `com.kindgi:kindgi-client` | `"com.kindgi" %% "kindgi-pack-scala"`, with the Java client |
| A pack's config | `kindgi.config.ts` | `pyproject.toml` (`[tool.kindgi]`) | `kindgi.config.json` | `kindgi.config.json` |
| The CLI, in a pack | `pnpm exec kindgi` | `uv run kindgi` | `./kindgiw` | `./kindgiw` |

Every SDK's version is the Kindgi release's. Scala apps call the API with the
Java client.

## In a pack

| Feature | TypeScript | Python | Java | Scala |
| --- | --- | --- | --- | --- |
| [Tools](../../guides/tools/write-a-tool/), with typed input and output | Yes | Yes | Yes | Yes |
| A handler that answers later (async) | Yes | Yes | Yes | Yes |
| [Read-only tools](../../guides/tools/read-only-tools/) | Yes | Yes | Yes | Yes |
| [Logging from a tool](../../guides/tools/write-a-tool/#log-from-a-tool) | Yes | Yes | Yes | Yes |
| [A side effect done once](../../guides/tools/write-a-tool/#make-a-side-effect-happen-once) (the idempotency key) | Yes | Yes | Yes | Yes |
| Cancellation | Yes | Yes | Yes | Yes |
| [A tool's secrets](../../guides/tools/give-a-tool-a-secret/) and [per-project values](../../guides/tools/give-a-tool-env-values/) | Yes | Yes | Yes | Yes |
| [Settings blocks](../../guides/evals/change-a-prompt-or-setting/) a tool reads | Yes | Yes | Yes | Yes |
| [HTTP tools without code](../../guides/tools/http-tools/) | Yes | Yes | Yes | Yes |
| [Guardrails](../../guides/guardrails/write-a-guardrail/) with your own check | Yes | Yes | Yes | Yes |
| [Agents](../../guides/agents/write-an-agent/), with [typed answers](../../guides/agents/typed-answer/), [memory](../../guides/agents/give-an-agent-memory/) and [budgets](../../guides/agents/budgets/) | Yes | Yes | Yes | Yes |
| [Flows](../../guides/flows/write-a-flow/): branches, loops, parallel steps, retries, approvals | Yes | Yes | Yes | Yes |
| Unit-testing a tool | Yes | Yes | Yes | Yes |
| A test context with env values and secrets, checked as a run checks them | Yes | Partly | Partly | Partly |

In Java and Scala, an agent's or a flow's fields beyond the builder's own go
in as data, as the API names them: `set("budget", …)`, `node(Map.of(…))`,
`edge(Map.of(…))`. So every agent and flow feature is there.

## In your app

| Feature | TypeScript | Python | Java | Scala |
| --- | --- | --- | --- | --- |
| Every API operation | Yes | Yes | Yes | Yes |
| [Start a run](../../guides/runs/start-a-run/), and wait for it or not | Yes | Yes | Yes | Yes |
| [Follow a run's events](../../guides/runs/follow-a-run/), reconnecting until it ends | Yes | Yes | Yes | Yes |
| Typed errors, and retries a call can take | Yes | Yes | Yes | Yes |
| [Comparing an agent version](../../guides/evals/compare-an-agent-version/): a helper that reads the comparison | Yes | Yes | Yes | Yes |
| [Verifying a webhook](../../guides/webhooks/verify-a-webhook/), reading its event, signing a test one | Yes | Yes | Yes | Yes |
| [Checking a signed export](../../guides/observability/export-signed-evidence/#check-an-export) | Yes | Yes | Yes | Yes |

## Where an SDK lacks a feature

- **A test context with env values and secrets:** in Python,
  `ToolContext.for_test(env=…, secrets=…)` sets them. In Java and Scala,
  build the context with `new ToolContext(…)`, which takes them. In those
  three, nothing fills in the defaults a tool declares for its env values or
  checks them, as TypeScript's `invokeToolForTest` does.

The guides show each language in its own tab. Where a guide has no tab for
your language, the [In a pack](#in-a-pack) and [In your app](#in-your-app)
tables say whether its SDK has the feature.
[Where an SDK lacks a feature](#where-an-sdk-lacks-a-feature) says what to do
instead.
