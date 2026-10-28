# Step 1: pull the corrections

The corrections are the agent's "no" judgments. Start from the version the
agent is running now, so you don't re-fix something an earlier version already
fixed:

```sh
kindgi agents live acme-store.refunds --project=<project-id>
```

`agents live` shows the version a run would use for the project (and
`agents live-versions` lists every scope with a live version). List that
version's "no" judgments — and, as you work through them, newer versions':

```sh
kindgi judgments list --agent=acme-store.refunds --agent-version=1.0.3 --verdict=no
```

- `--agent-version` (it needs `--agent`) scopes to one version — the live one,
  to start. Older versions' corrections may already be fixed; without a version
  you get every version's.
- `--verdict=no` keeps only the corrections. (Leave it off to see what the
  experts confirmed as right, too.)
- `--class=<judge-class-id>` keeps only one judge class — use it to take
  only the experts' corrections once the project names its experts.

Kindgi doesn't hand out corrections: two people's coding agents can pull the
same "no" judgments, so agree outside Kindgi who takes which before you start.

Read each one in full for the reason the expert gave and the run it's on:

```sh
kindgi judgments show <judgment-id>
kindgi runs get <run-id>
kindgi runs journal <run-id>
```

`runs get` is the run's snapshot; `runs journal` is its durable record,
step by step, where the agent's tool calls and their arguments are. Between
the correction's reason and the run, you have what the agent did and what it
should have done.

An expert can also have said exactly what the run should have done (runtime
0.2.0 or later): the judgment then has a `correction`, with `calls` (each
`{ tool, args }`, with only the argument fields that matter) and `notCalled`
(the tools it shouldn't have called). Take those as what the pack test
asserts. It's the expert's: never record or change a correction yourself.
Test cases built from the run check each new version against it.
