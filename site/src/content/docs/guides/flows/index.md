---
title: Flows
description: Write a flow, pass data between its steps, branch, loop, run steps in parallel, retry, wait for a person and dry-run it.
sidebar:
  order: 0
  label: Overview
---

These guides write a flow and shape how it runs: its data, its branches,
loops and parallel steps, its retries, a person's approval, and dry runs.

A **flow** is a graph of steps that runs in a known order. Tool steps run
your code, agent steps ask a model for a judgment, and edges between them
decide what runs next. A flow is data, versioned and checked when it loads.
Every run of it is recorded step by step in its journal.

Use a flow when you know the order of the work, such as look up, decide, then
act. Use a single agent when the model should decide the order.

- [Write a flow](write-a-flow/): tool and agent steps, edges, and running it.
- [Pass data between steps](pass-data-between-steps/): a step's input from
  the run input and earlier steps, and the run's output.
- [Branch a flow](branch-a-flow/): edges that fire only when a condition holds.
- [Join branches](join-branches/): a step that waits for whichever branches ran.
- [Repeat steps in a loop](loop/): once per element of a list, or until a
  condition holds.
- [Run steps in parallel](run-steps-in-parallel/): several tools on the same
  input at once.
- [Retry a failing step](retry-a-step/): retries with backoff, and a time
  limit per step.
- [Wait for an approval](wait-for-an-approval/): a flow that stops until a
  person decides.
- [Dry-run a flow](dry-run-a-flow/): run the steps that only read, and stop
  before the first one that writes.
- [Pin a flow's version](pin-a-flow-version/): keep runs on the version you
  checked while you try a newer one.

The examples build up one pack, `acme`, from the `sample` template:
`kindgi init acme --template=sample`, or `--template=python`. Each page shows
the tools it adds, and [Write a flow](write-a-flow/) has the first ones.
Where a model matters, the output is from Claude Haiku 4.5. Outputs on newer
models, such as Claude Sonnet 5.5, differ in wording, not shape. The model is
registered with `kindgi providers register --preset=anthropic`, as
[Models](../models/) shows.
