---
title: Guides
description: How to do one thing with Kindgi, in TypeScript and in Python.
sidebar:
  order: 0
  label: Overview
---

Short, task-focused pages. Each assumes the basics from [Start](../start/),
shows TypeScript and Python side by side, and was run as written against the
version of Kindgi these docs describe.

- [Tools](tools/): write a tool in TypeScript or Python, call an HTTP API
  without code, give a tool a secret, mark it read-only, and use an MCP
  server's tools.
- [Agents](agents/): write an agent, give it input, get a typed answer,
  choose its model, hold a conversation and cap what a turn may spend.
- [Models](models/): connect Anthropic, Gemini on Vertex AI, an
  OpenAI-compatible endpoint, or a model you serve yourself.
- [Flows](flows/): pass data between steps, branch, loop, run steps in
  parallel, retry, wait for a person, and dry-run a flow.
- [Runs](runs/): start runs from the CLI or your app, retry safely, follow
  them live (from the browser too), read their journal, cancel and list
  them.
- [Orgs and projects](projects/organize-by-org-and-project/): give each
  customer an org with its projects, and run and read their work by project
  or org.
- [Webhooks](webhooks/): get a signed `run.finished` request when a run
  ends, verify it in your app, and test and replay deliveries.
- [Guardrails](guardrails/): check an agent's answers, give a check its
  settings, and choose whether a failure stops the turn.
- [Approvals](approvals/): have a person approve what an agent does before
  it happens.
- [Secrets and env](secrets/): where a pack's settings and secrets live on
  your machine and in a deployment, and how your code gets them.
- [Sign-in](sso/sign-in/): signing in to the console, sessions, and the
  enterprise sign-in options, built with you.
- [Cost and provenance](observability/trace-an-answer/): trace an answer to
  the model and tool calls behind it, and what each call cost.
- [Evals](evals/judge-a-runs-output/): judge runs' answers, build a test set
  from them, change a prompt or a setting without a deploy, compare the new
  version on the test set, and release it.
