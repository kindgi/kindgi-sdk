---
title: How Kindgi fits your app
description: Your app, your pack's code, the Kindgi runtime and the models — what runs where, and how a run moves between them.
sidebar:
  order: 1
---

This page shows what runs where when you use Kindgi, so you can tell which
part a request, a secret or a failure belongs to.

Kindgi sits beside your application, not in front of it. Your app keeps its
own code, data and users. Kindgi runs the agents and flows you define, calls
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

- **Your app** starts runs and reads their results over HTTP, through an
  SDK. It can wait for a run. It can also start a run in the background and
  get a signed webhook when the run ends.
- **Your pack** is the Kindgi part of your repository: tools, guardrails,
  agents and flows. Agents and flows are data the runtime runs; tools and
  guardrail checks are code.
- **The pack service** runs that code. It's a process built from your app,
  with your app's dependencies, in your environment. The runtime calls it
  over HTTP for each tool call, with a deadline. It can reach whatever your
  code reaches, such as your database and your services.
- **The runtime** is Kindgi itself: the API, the engine that runs agents and
  flows step by step, the journal of every step in Postgres, the secrets
  your tools use, and the calls to model providers. It ships as a container
  image.
- **Model providers** are registered per workspace. A provider is a vendor's
  API, or a model you serve inside your own network. An agent states what it
  needs, and Kindgi picks a model that fits.
- **The console**, at `/console/` on any runtime, shows each run on one page:
  what it did and cost, its journal, and where an agent's answer came from.
  It shows the agents, tools and conversations, project by project.
  Reviewers approve or reject there. It follows your system's light or dark
  setting, or the one you choose in its settings or with ⌘K.

## Where it runs

The same runtime image runs everywhere:

- **On your machine:** `kindgi dev` starts it as a container, with a
  Postgres. It runs your pack's code on your machine and reloads it on every
  save.
- **In your infrastructure:** you deploy the runtime and your pack service
  next to your data. Prompts, data and keys stay there. See
  [Deploy](../../deploy/).
- **Kindgi Cloud:** Kindgi operates the runtime for you (private preview).

:::note[Access to the runtime image]
Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub or your
email address for a license key. The key is also the runtime image's
password ([Pull the runtime image](../../deploy/self-hosted/pull-the-runtime-image/)). Questions or trouble: contact@kindgi.com.
:::

## What stays yours

Your code stays in your repository and runs in your process. Your data stays
where your code reads it. Secrets your tools need are referenced by name and
resolved for each call. Kindgi doesn't copy them into your code. With a model
you serve inside your network, your prompts stay there too.
