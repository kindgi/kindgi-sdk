---
title: How Kindgi fits your app
description: Your app, your pack's code, the Kindgi runtime and the models — what runs where, and how a run moves between them.
sidebar:
  order: 1
---

Kindgi sits beside your application, not in front of it. Your app keeps its
own code, data and users; Kindgi runs the agents and flows you define, calls
your code when they need it, and records every step.

```
  Your app ──── HTTP: start runs, follow them ────▶  Kindgi runtime
     ▲                                                │  API, run engine,
     │ signed webhooks (run.finished)                 │  journal (Postgres)
     └────────────────────────────────────────────────┤
                                                      ├──▶ Model providers
                                                      │    (Anthropic, Gemini,
                                                      │     OpenAI-compatible,
                                                      │     a model you serve)
                                                      │
                                                      └──▶ Pack service
                                                           your tools and
                                                           guardrail checks,
                                                           your code
```

## The parts

- **Your app** starts runs and reads their results over HTTP, through the
  TypeScript or Python SDK. It can wait for a run, or start it in the
  background and get a signed webhook when it ends.
- **Your pack** is the Kindgi part of your repository: tools, guardrails,
  agents and flows. Agents and flows are data the runtime runs; tools and
  guardrail checks are code.
- **The pack service** runs that code: a process built from your app (Node
  or Python), with your app's dependencies, in your environment. The runtime
  calls it over HTTP for each tool call, with a deadline, and it can reach
  whatever your code reaches: your database, your services.
- **The runtime** is Kindgi itself: the API, the engine that runs agents and
  flows step by step, the journal of every step in Postgres, the secrets
  your tools use, and the calls to model providers. It ships as a container
  image.
- **Model providers** are registered per tenant: a vendor's API, or a model
  you serve inside your own network. An agent states what it needs; Kindgi
  picks a model that fits.
- **The console**, at `/console` on any runtime, shows each run on one page
  (what it did and cost, its journal, and where an agent's answer came from),
  the agents, tools and conversations, project by project; reviewers approve
  or reject there.

## Where it runs

The same runtime image runs everywhere:

- **On your machine:** `kindgi dev` starts it as a container, with a
  Postgres, and runs your pack's code on your machine, reloading on every
  save.
- **In your infrastructure:** you deploy the runtime and your pack service
  next to your data. Prompts, data and keys stay there. See
  [Deploy](../../deploy/).
- **Kindgi Cloud:** we operate the runtime for you (private preview).

:::note[Private preview]
The runtime image is in private preview: request access at contact@kindgi.com.
:::

## What stays yours

Your code stays in your repository and runs in your process. Your data stays
where your code reads it. Secrets your tools need are referenced by name and
resolved for each call; Kindgi doesn't copy them into your code. With a
model you serve inside your network, your prompts stay there too.
