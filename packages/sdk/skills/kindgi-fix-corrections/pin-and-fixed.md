# Step 4 — The pin, and Fixed in vN

A suggested change is pinned with `kindgi suggested-changes pin` (Step 3). A
version made any other way, such as one a deploy made, is pinned with
`kindgi agents pin`. Ask what would happen first, then ask for it:

```sh
kindgi agents pin acme-store.refunds 1.0.4 --project=<project-id> --check
kindgi agents pin acme-store.refunds 1.0.4 --project=<project-id> \
  --reason="Fixes 1 correction: our return window is 14 days"
```

- The scope is `--tenant` (every project), `--org=<org-id>`, or
  `--project=<project-id> [--segment=<key:value>]…` (one project).
- `--check` changes nothing and answers `would-pin`, `needs-approval` or
  `gate-failed`.
- `--test-run=<test-run-id>` names a test run of the version for the release
  gate to read.
- The answer is `pinned`, or `pending-approval` when the scope's release
  gate has `approvals` and a second person must approve. Whoever asked
  can't approve their own request, unless the gate sets
  `separateApprover: false`. `--wait` waits for the decision.
- `--check` and the pin exit 3 when the answer is no or the pin waits for an
  approval. Read the printed answer: exit 3 isn't an error.
- Pinning needs `pin` on the agent, which its admins hold.

## What a pin checks and marks

When a project starts running another version (a pin, an unpin, going
back, or its Latest moving with a deploy), Kindgi checks that version on the
project's part of the agent's test set. A finished check of the same version
on the same cases, such as the suggested change's, is used again. Then each
of the project's corrections with a case is updated:

- **It passes:** `open`, `being-fixed` and `with-owner` become `fixed`, with
  `fixedIn`: the version, how it got there (`pin` or `latest`), and when.
- **It fails, and was fixed:** it's reopened, with `reopenedIn` beside its
  `fixedIn`.
- The rest don't change.

The pin's answer says which:

```json
{ "pin": { "status": "pinned", … }, "testRunId": "…", "fixed": ["c-311"], "reopened": [] }
```

- When the pin waits for a second person, the lists are empty: the
  statuses change when it's approved.
- When there was no finished check to use, the lists are empty and
  `testRunId` names the run it started: the statuses change when that run
  ends. `kindgi corrections show <id>` shows them then.

Report the outcome to the person in those words: "1.0.4 is pinned for
Support; it fixes c-311 and reopens nothing."

## A project that follows Latest

The first pin on a project that runs its Latest stops it following Latest,
so it's refused (`409 pin-stops-latest`, naming what the project runs)
unless you say so with `--stop-following-latest`. That's the person's call:
ask them. A suggested change can be added as the project's Latest instead
(Step 3).

## Going back

There's no rollback. Going back is a pin of the earlier version, through the
same release gate and second person, with a `--reason`. The corrections the
earlier version fails reopen. `kindgi agents unpin <agent-id> --project=<project-id>`
takes the pin away instead: the project follows its Latest again.
`kindgi agents pin-history list <agent-id>` shows every pin and unpin, with
who asked and why.

## Under `kindgi dev`

A pin there is for the whole workspace (`--tenant`; an `--org` or
`--project` pin is 409 `registry-read-only`). An Improve run's pin waits for
an approval there, which the person gives themselves (`kindgi dev` registers
them as a reviewer), from the suggested change's page. Approved, it writes
the version's prompts and settings into the pack's files: tell the person to
commit them first. `kindgi dev` reloads them, and the pin's test runs check
the agent's project, the default one, and mark what it fixes, as above.
Going back is a pin of the version before, for the whole workspace too: it
writes the files back as they were right before the pin, and its test runs
reopen what that version fails. An unpin is refused there. After a block is
edited by hand and given a new version since the pin, the files read as the
pack's own version again, so a pin of the version before writes nothing: git
is the way back then. Going back with git changes the files with no pin, so
the corrections the pin fixed stay `fixed`. Tell the person to give a block
a new version whenever they edit it by hand: a pin refuses a file that
changed at a version `kindgi dev` already has (kept before a pin, or an
Improve version), and says so.
