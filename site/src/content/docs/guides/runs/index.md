---
title: Runs
description: Start runs from the CLI or your app, retry safely, run them on a schedule, follow them live, read their journal, cancel and list them.
sidebar:
  order: 0
  label: Overview
---

A **run** is one execution of a flow, or one turn of an agent. Your app starts
it, follows it, and reads what it returned; the journal records every step.
[Runs, the journal and durability](../../concepts/runs/) explains the model.

- [Start a run](start-a-run/): wait for its result, or start it in the
  background.
- [Retry a start safely](retry-a-start-safely/): an idempotency key, so a
  retried request doesn't start a second run.
- [Run on a schedule](run-on-a-schedule/): an agent or a flow at set times,
  as you, with a history of each time it ran or why it didn't.
- [Follow a run's events](follow-a-run/): each step as it starts and ends.
- [Follow a run from the browser](follow-from-the-browser/): a short-lived,
  read-only token, so a page can show progress without your API token.
- [Read a run's journal](read-the-journal/): everything that happened in a
  run, with each step's input and output.
- [Cancel a run](cancel-a-run/): stop a run that's running or waiting.
- [List runs](list-runs/): the newest runs, page by page, and the runs inside
  a run.
- [Show runs in your app](show-runs-in-your-app/): keep a run's id on your
  own row, and read the rest through the API, not Kindgi's database.
- [Keep files with a run](keep-files-with-a-run/): store a file as an
  artifact, with its run or in a project, and download it later.

The examples use the flows from the [flow guides](../flows/), and a client
for the Kindgi API: `@kindgi/sdk/client` in TypeScript, `kindgi.client` in
Python.
