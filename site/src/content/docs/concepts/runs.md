---
title: Runs, the journal and durability
description: What a run is, how every step is recorded, and how long work survives and continues.
sidebar:
  order: 3
---

This page explains what a run is, how Kindgi records it, and how a run
survives a wait or a runtime that stops.

A **run** is one execution of a flow, or one turn of an agent. Every run
has an id, a status, and a **journal**: the ordered record of everything
that happened in it.

## The journal

Each step that starts, completes or fails is written to the journal before
the run moves on, with its inputs and outputs. So is each edge the run
follows or skips. An agent's turn is a run of its own. Its journal holds the
model calls and the tool calls in order. Each model call names the provider
and the model, with the tokens and the cost.

The journal answers "why did it do that?" after the fact. It shows which
step ran with what input, what the model was asked and what it answered, and
which branch the flow took. [Read a run's journal](../../guides/runs/read-the-journal/)
shows how to print it.

## Waiting, or not

Your app chooses how to start a run:

- **Wait** for it: the call returns when the run completes or fails, with
  its output.
- **Start it in the background** with `wait: false`: the call returns as
  soon as the run exists. Your app can follow the run's events, a stream your
  browser can read directly with a short-lived read-only token. Or Kindgi can
  send your app a signed `run.finished` webhook when the run ends.

## How it started

Each run says how it started, as `startedBy`:

- **`person`:** a person, signed in or with their own API key.
- **`key`:** a service account's key.
- **`schedule`, `webhook` or `event`:** a trigger.

It's set when the run starts and never changes: a person who approves a
step doesn't make the run theirs. A run that a run starts, such as a flow's
agent step, started the way its run did.

Only a run a person started counts as attended. A tool can ask for a
person's yes on every call in any other run, as
[When no person started the run](../../guides/approvals/ask-before-a-tool-runs/#when-no-person-started-the-run)
shows. In a run a webhook or an event started, an agent reads its message
as data, not instructions, as
[What its agents read](../../guides/webhooks/start-runs-from-webhooks/#what-its-agents-read)
shows.

## Durable

A run's state is the journal, not a process's memory. A run that waits for
a person's approval is parked at a **waitpoint**. It continues when a
reviewer decides the approval, as
[Decide an approval](../../guides/approvals/decide-an-approval/) shows.

A start repeated with the same **idempotency key** never starts a second
run. Once the first call has answered, the repeat returns the run the first
call started. While the first call is still running, the repeat is refused
with a conflict, `idempotency-key-in-flight`. See
[Retry a start safely](../../guides/runs/retry-a-start-safely/).

### If the runtime stops

A runtime that's shut down, by a deploy or `docker stop`, gives the runs
it's executing a few seconds to finish. [Restart the runtime](../../deploy/self-hosted/restart-and-check-health/#restart-the-runtime)
has the details. A runtime can also stop without a shutdown: it's killed, it
runs out of memory, or it crashes. It then leaves its runs mid-way.

Kindgi finds those runs by their **lease**. The server executing a run renews
the run's lease while the run goes on. Every server sweeps for leases that ran
out:

- `KINDGI_RUN_LEASE_MS` is a lease's length, 5 minutes by default.
- `KINDGI_RUN_SWEEP_INTERVAL_MS` is the time between sweeps, a minute by
  default.

Within about a lease plus a sweep:

- **A run that was executing fails**, and `run.finished` tells your app.
- **A run whose wait was resolved** (its approval decided) but that nothing
  resumed **is resumed**. After three failed attempts it fails:
  `Interrupted: the run was ready to continue, but every attempt to resume it failed.`
- **A flow waiting on a child run that already ended is woken**, and goes on.
- **A run whose parent run ended is ended too:** cancelled when the parent
  was cancelled, otherwise failed:
  `Interrupted: its parent run had ended (failed), so nothing waits for it.`
  So an approval inside a cancelled flow can't run its tools.

A new run gets at least a minute before a sweep can pick it up, whatever
the lease.

## Dry runs

A dry run runs a flow without changing anything. Only the tools declared
read-only, with `mutating: false`, run, and an agent's turn skips its model
call. A dry run checks a flow's wiring before it touches real data:
[Dry-run a flow](../../guides/flows/dry-run-a-flow/) shows how.

## Provenance and cost

Because every step is recorded, every answer can be traced to where it came
from: the agent's turn, the model call and the tool results it used.
`GET /v1/provenance/{runId}` returns that graph, and
[Trace an answer](../../guides/observability/trace-an-answer/) reads it.

Each model call is recorded with its tokens and cost too. So you can read
what a run, a flow's whole run or one customer's month cost, as
[Cost per run and per customer](../../guides/observability/cost-per-run/)
shows.

In the console, a run's page shows all of it: what the run did and what it
cost (Overview), its journal, one sentence per step (Journal), and where the
answer came from, as a list of steps or a graph (Provenance).
