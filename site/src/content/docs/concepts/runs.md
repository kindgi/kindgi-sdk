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

### If the runtime stops

A runtime that's shut down (a deploy, `docker stop`) gives the runs it's
executing a few seconds to finish
([Operate](../../deploy/operate/#restart-the-runtime)). One that stops without
a shutdown (killed, out of memory, a crash) leaves its runs mid-way. Kindgi
finds them by their **lease**: the server executing a run renews it while the
run goes on. Every server sweeps for leases that ran out
(`KINDGI_RUN_LEASE_MS`, default 5 minutes; `KINDGI_RUN_SWEEP_INTERVAL_MS`,
default a minute), and within about a lease plus a sweep:

- **A run that was executing fails**, and `run.finished` tells your app.
- **A run whose wait was resolved** (its approval decided) but that nothing
  resumed **is resumed**. After three failed attempts it fails:
  `Interrupted: the run was ready to continue, but every attempt to resume it failed.`
- **A flow waiting on a child run that already ended is woken**, and goes on.
- **A run whose parent run ended is ended too:** cancelled when the parent
  was cancelled, otherwise failed:
  `Interrupted: its parent run had ended (failed), so nothing waits for it.`
  So an approval inside a cancelled flow can't run its tools.

A run that was just started gets at least a minute before a sweep can pick
it up, whatever the lease.

## Dry runs

A dry run (`--dry-run`) runs a flow without changing anything: only the
tools declared read-only (`mutating: false`) run, and an agent's turn skips
its model call. Use it to check a flow's wiring before it touches real data.

## Provenance and cost

Because every step is recorded, every answer can be traced to where it came
from: the agent's turn, the model call, the tool results it used.
`GET /v1/provenance/{runId}` returns that graph;
[Trace an answer](../../guides/observability/trace-an-answer/) reads it.
