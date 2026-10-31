# Step 1 — Pull the open corrections

Start from what the project runs now, so you fix that version:

```sh
kindgi agents pinned acme-store.refunds --project=<project-id>
```

It answers the version a run in the project gets, and whether that's a pin
or the project's Latest (`via`). List the project's open corrections that
are sorted to a developer:

```sh
kindgi corrections list --agent=acme-store.refunds --project=<project-id> \
  --status=open --sorted-to=developer
```

- `--status` is `open`, `being-fixed`, `with-owner`, `fixed` or `wont-fix`,
  and repeats.
- `--sorted-to` is `developer`, `improve` or `owner`, and repeats. Take a
  correction sorted elsewhere only when the person asks you to: one sorted
  to `owner` is the owner's to pass on, and one sorted to `improve` waits
  for an Improve run.
- `--from=experts` keeps the corrections from expert groups, and
  `--from=end-users` the ones customers made. An end user's correction
  nobody sorted has no `sortedTo`, so `--sorted-to` leaves it out.

A correction that's `being-fixed` is someone's already: its `link` names the
pull request, Improve run or suggested change. Leave it.

Read each one in full, with its run:

```sh
kindgi corrections show <correction-id>
kindgi runs get <run-id>
kindgi runs journal <run-id>
```

`runs get` is the run's snapshot; `runs journal` is its durable record, step
by step, where the agent's tool calls and their arguments are.

The correction says what was wrong, part by part:

- **`decisions: "wrong"`**, with `shouldCall` (each `{ tool, args }`, with
  only the argument fields that matter) and `mustNotCall` (the tools it
  shouldn't have called). A test case checks these exactly, without a model.
- **`answer: "wrong"`**, with `shouldSay` or `why`. A judging model checks a
  new answer against them.
- **`why`**: the person's reason, in their words.

Take those as what your pack test asserts. They're the person's: never edit
what a correction says.

## Mark the ones you take

When you start on one, set it `being-fixed` with where the fix is, so nobody
else takes it:

```sh
kindgi corrections set <correction-id> --status=being-fixed \
  --link=https://github.com/acme/store-agents/pull/219
```

- `--link` takes a pull request's URL, a suggested change as `sc-` and its
  id (`--link=sc-<suggested-change-id>`), or an Improve run as `ir-` and its
  id.
- Changing a correction's status needs `publish` on the agent.
- If you stop without a fix, set it back with `--status=open`.
- Nobody sets `fixed` by hand: a pin does (Step 4).
