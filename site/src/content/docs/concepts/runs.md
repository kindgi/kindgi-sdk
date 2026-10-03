---
title: Runs, the journal and durability
description: What a run is, how every step is recorded, and how long work survives and continues.
sidebar:
  order: 3
---

A **run** is one execution of a flow, or one turn of an agent. Every run
has an id, a status, and a **journal**: the ordered record of everything
that happened in it.

## The journal

Each step that starts, completes or fails, and each edge the run follows or
skips, is written to the journal before the run moves on, with its inputs
and outputs. An agent's turn is a run of its own, with the model calls (the
provider, the model, the tokens and the cost) and the tool calls in order.

```sh
kindgi runs journal <run-id>
```

The journal is how you answer "why did it do that?" after the fact: which
step ran, with what input, what the model was asked and what it answered,
which branch the flow took.

## Waiting, or not

Your app chooses how to start a run:

- **Wait** for it: the call returns when the run completes or fails, with
  its output.
- **Start it in the background** (`wait: false`): the call returns as soon
  as the run exists. Follow it with its events (a stream your browser can
  read directly, with a short-lived read-only token), or let Kindgi send your
  app a signed `run.finished` webhook when it ends.

## Durable

A run's state is the journal, not a process's memory. A run that waits for
a person's approval is parked at a **waitpoint**, and continues when a
reviewer decides the approval:

```sh
kindgi approvals complete <approval-id> --decision=approve
```

Retries are safe: a start with the same **idempotency key** returns the run
the first call started.

## Dry runs

A dry run (`--dry-run`) runs a flow without changing anything: only the
tools declared read-only (`mutating: false`) run, and an agent's turn skips
its model call. Use it to check a flow's wiring before it touches real data.

## Provenance and cost

Because every step is recorded, every answer can be traced to where it came
from: the agent's turn, the model call, the tool results it used. The
console shows a run as that graph, with the cost of each model call, and
`GET /v1/provenance/{runId}` returns it.
