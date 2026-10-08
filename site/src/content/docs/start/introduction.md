---
title: What is Kindgi?
description: Packs, the runtime, and how your app and your coding agent work with them.
sidebar:
  order: 1
---

Kindgi runs the AI parts of your application (tools, agents, flows and
guardrails) durably, on infrastructure you choose, and records every step
they take.

## Your code, as a pack

A **pack** is the Kindgi part of your app, written in the app's own
language and living in its repository:

- **Tools:** functions the app already has, exposed to agents and flows: a
  database lookup, a ticket write, an HTTP API.
- **Agents:** a model with instructions and tools, answering with a typed
  result your code can rely on.
- **Flows:** your process as steps and branches: an agent triages, a tool
  writes, an approval waits for a person.
- **Guardrails:** checks on what an agent says or does before it counts.

You write packs in **TypeScript** (`@kindgi/sdk`) or **Python** (the
`kindgi` package). Tools call your app's own modules; nothing is rewritten
for Kindgi.

## The runtime

The Kindgi runtime runs agent turns and flows **durably**: each step is
journaled, a run can be resumed, and long work continues in the background
while your app carries on. Models come from providers you register:
Anthropic, Gemini, or any OpenAI-compatible endpoint, including an open
model served inside your own network.

Your app talks to the runtime over HTTP: it starts runs, follows their
events as they happen, and receives signed webhooks when they finish.

## Four ways in

- **The CLI** (`@kindgi/cli`): create a pack, run it locally with
  `kindgi dev`, build and deploy it.
- **The HTTP API:** every operation, for any language.
- **The SDKs:** TypeScript and Python clients for the API.
- **The console:** in your browser, at `/console/` on any runtime, where the
  runtime's own address leads (with `kindgi dev`,
  `http://127.0.0.1:4000/console/`; `kindgi console` opens it). Each run has one page: what
  the agent was asked, the tools it called and their results, its answer, the
  model and the cost; its journal, one sentence per step; and where the answer
  came from. It also has approvals to approve or reject, conversations, and
  the agents and tools your pack defines. A project's pages show that
  project's records, with a switch to see all of them.

## Your coding agent

`kindgi init` installs skills for Claude Code into the project, so your
coding agent writes tools, agents, flows and guardrails the way Kindgi
expects, without you learning a new API first. The skills also tell it
which commands to run: `kindgi dev` to start Kindgi, `kindgi runs start` to
try what it wrote, and the run's journal when something fails.
[How it knows Kindgi](../coding-agents/).

## Where it runs

- **On your machine:** `kindgi dev` runs the runtime as a container next to
  your pack's code and picks up every save. (Its image's pull credentials
  come from [access.kindgi.com](https://access.kindgi.com), with GitHub.)
- **In your own cloud:** you deploy the same runtime image into your
  project; your data and prompts stay there.
- **Kindgi Cloud:** we operate the runtime for you. It's in private
  preview.

## Status

Kindgi is in **preview**: APIs may change between `0.x` releases. These
docs are versioned with each release; the version menu shows which one
you're reading.

The SDKs are Apache-2.0. The runtime is source-available under the Business
Source License 1.1.
