# Step 3 — A setting or the wording: suggest a change

## Contents

- Its check
- Pin it, or add it as Latest
- Bring the pack up to it
- Wording, with Improve

A setting's value, or the agent's wording when the person said exactly what
it should say, is fixed with a suggested change: a new version of one block,
made for one project on the version it runs, and checked on the agent's test
set before anyone pins it. No code changes.

```sh
kindgi suggested-changes create --agent=acme-store.refunds --project=<project-id> \
  --block=acme.store-policy --values=@store-policy.json \
  --why="Our return window is 14 days" --fixes=<correction-id>
```

- `--block` names a block the project's version already pins. A new key, or
  a block the agent doesn't use yet, is a code change.
- `--values` is a settings block's new values, checked against its schema.
  `--template` is a prompt block's new text instead. Either takes a file as
  `@<file>`.
- `--why` says what it fixes, and each `--fixes` names a correction it
  fixes.
- It makes the block's new version and the agent version that pins it, and
  starts its check. Read the new version from the output rather than
  assuming one. The same change again answers the suggested change made
  before: don't make another.
- It needs `publish` on the agent.

Then mark each correction it fixes `being-fixed`, with
`--link=sc-<suggested-change-id>` (Step 1).

## Its check

The check runs the suggested change's version (`with`) and the version it's
built on (`now`) on the same cases: the project's part of the agent's test
set, frozen when the check starts. The suggested change is `checking`, then
`ready`, or `check-failed` when a side didn't finish.

```sh
kindgi suggested-changes get <suggested-change-id>
kindgi suggested-changes check <suggested-change-id> --wait
```

- `get` shows the change, block content before and after, and `check`:
  each side's `passing` of `of`, and `newlyFailing`, the corrections `now`
  passes and `with` fails.
- `check --wait` checks it again on the test set as it is now, so a
  correction made since counts, and waits for it.
- `ready` says the check finished, not that the change is better. A change
  with `newlyFailing` cases broke something: fix that first, or say so.

## Pin it, or add it as Latest

What the project runs decides which:

- **A project that runs a pin:** ask to pin it.

  ```sh
  kindgi suggested-changes pin <suggested-change-id> \
    --reason="Fixes 1 correction: our return window is 14 days"
  ```

  It goes through the project's release gate with its check. It's `pinned`,
  or `waiting-for-second-person` when the gate asks for an approval. A
  refusal lists every check the gate made, and leaves it `ready`. It needs
  `pin` on the agent.
- **A project that runs its Latest:** add it as the project's Latest
  instead, with `kindgi suggested-changes add-as-latest <id> --reason=…`.
  There's no release gate on Latest: the project runs it from then on.

`--reason` is kept on the record: write what the corrections were, so the
approver reads the change in plain words. A suggested change nobody should
take is withdrawn with `kindgi suggested-changes withdraw <id> --reason=…`.

## Bring the pack up to it

Once it's pinned or added, the project runs a block version your pack's
`blocks/` folder doesn't have yet. Bring the block's file up to it, through
the repo:

```sh
kindgi suggested-changes pull <suggested-change-id> --pr
```

It writes the block's `version` and content (and its template file) on a new
branch, `kindgi/<block>-<version>`, from the one checked out; commits those
files alone, pushes, and opens a pull request with `gh` (without `gh`, it
prints the URL that opens one). The corrections it fixes that are still
`open` are then `being-fixed`, linked to the pull request. Without `--pr`, it
only writes the files. It refuses a block file that holds a newer version
than the one the suggested change is built on, and, with `--pr`, block files
with changes that aren't committed. Under `kindgi dev` the pin writes them
itself. Making one by hand or checking one again is 409
`registry-read-only`: edit the file, or run Improve.

## Wording, with Improve

When the person said what was wrong with the wording but not what to say,
leave the wording to Improve. It tries rewrites on the corrections sorted
to it, and makes a suggested change only when one does better on the test
set:

```sh
kindgi improve runs start --agent=acme-store.refunds --project=<project-id> --check
kindgi improve runs start --agent=acme-store.refunds --project=<project-id>
```

`--check` starts nothing: it lists what's missing before a run can start,
and what it would cost. Its suggested change is pinned like yours. Under
`kindgi dev`, run it in the default project, and have the person commit the
pack's files before a pin writes into them. A file edited since is 409
`pin-superseded`, and one built on a version that no longer runs 409
`suggested-change-out-of-date`: run Improve again. An Improve schedule starts
no run there: start Improve by hand.
