---
title: Packs and primitives
description: Tools, agents, flows and guardrails — what each one is, and how a pack holds them.
sidebar:
  order: 2
---

A **pack** is everything Kindgi runs for your app, defined in your app's own
language. It has an id (`acme-desk`) and a version, and holds four kinds of
**primitives**, each with its own id under the pack's (`acme-desk.triage`).

## Tools: your code

A tool is a function with a typed input and output. Kindgi checks both on
every call, so an agent can't hand your code something malformed.

- **Code tools** are your functions (TypeScript `defineTool`, Python
  `@tool`). They run in the pack service, so they import your app's modules
  and reach what your app reaches.
- **HTTP tools** are one HTTP request, declared with no handler (`http_tool`
  in Python, an `http` spec in TypeScript). The runtime makes the request,
  resolving its secret for each call.
- A tool declares whether it **changes anything**. One declared read-only
  (`mutating: false`) runs in a dry run, and approval rules can skip it.

## Agents: a model with instructions and tools

An agent is data: instructions, the tools it may call, the guardrails on its
answers, a budget (steps, cost, time), and what it needs from a model (tool
use, typed output). It can answer with a **typed result**, a schema Kindgi
checks; if the model's answer doesn't fit, Kindgi asks it to repair the
answer once, then fails the turn instead of passing on bad data.

## Flows: your process

A flow is your process as data: steps and the edges between them.

- **Steps** run a tool or an agent, with their input mapped from the run's
  input or earlier steps' outputs.
- **Edges** can carry conditions (`when`), so a flow branches: an agent
  triages, and only an urgent message reaches the step that writes a ticket.
- Flows can join branches, loop over items, and fan out to run steps in
  parallel.

## Guardrails: checks on what an agent does

A guardrail is a check over an agent's turn: its answer, its tool calls,
their results. It passes or fails, with a reason. A failed check can halt
the turn or be recorded as a violation.

## How a pack is found

Kindgi finds primitives by folder: `tools/`, `agents/`, `flows/` and
`guardrails/` (under `kindgi/` when the pack lives inside an app). The
**indexer** reads them into the pack's `index.json`, the same file for a
TypeScript or a Python pack, and the runtime registers what it lists.
`kindgi dev` re-indexes on every save; `kindgi build` puts the index in the
image.

See the [Packages](../../reference/packages/) and
[JSON Schemas](../../reference/schemas/) reference for every field.
