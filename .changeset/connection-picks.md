---
"@kindgi/tools": patch
"@kindgi/connections-inmemory": patch
"@kindgi/agents": patch
---

**A run's record says how each connection a call used was picked, and through which registration.** A call's connection record in the run's journal gains `pick`: `by` is `mailbox` (the company connection the run's mail came to), `choice` (the agent's or flow's choice, with its `choiceId`), `only` (the project's only company connection of the app) or `own` (the person's own connection), and `registration` is the app's registration it came through, `{ id, name }`, named by its label, else by its app's name and its id's first 8 characters. Records from older runtimes have no `pick`. Any project reader reads a run's record, so it never names a person's connection: a person's has their account and no `name`, and so does their approval.

- `@kindgi/tools`: `ConnectionPick`, and `picks` on a ready `ResolveConnectionsOutcome`, keyed like `connections`. A tool never sees them.
- `@kindgi/connections-inmemory`: answers each ready need with its pick.
- `@kindgi/agents`: the connection gate records each pick, and a connection's `name` for a company need only.
