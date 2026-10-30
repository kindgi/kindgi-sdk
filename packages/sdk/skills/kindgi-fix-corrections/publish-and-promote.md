# Step 4 — Publish, and ask to make it live

For a **setting** change, publish the block, then derive a new agent version
that pins it — no code change:

```sh
kindgi blocks publish acme.store-policy \
  --block-version=1.0.1 --project=<project-id> \
  --settings=@store-policy.json --schema=@store-policy.schema.json
kindgi agents derive acme-store.refunds \
  --from=1.0.3 --setting=acme.store-policy=1.0.1 --label="return window 14 days"
```

- `blocks publish` takes `--block-version` (a semver, not `--version`) and a
  required `--project`. `--settings` is the block's values; `--schema`
  constrains them. (`--prompt` publishes a prompt block instead; the two are
  mutually exclusive.)
- `agents derive --setting=<block-id>=<version>` re-pins a block the version
  *already* references to its new version (repeat `--setting`/`--prompt` for
  several). It makes the first free patch after the agent's highest version and
  prints it — read that version from its output rather than assuming one. If it
  answers `reused`, an identical version already exists: use that, don't derive
  again.

For a **code** change, `kindgi deploy` publishes the new version with the
changed tool.

Deriving needs `publish` on the agent, `blocks publish` needs `write` on the
project, and promoting needs `promote` — the permission that makes a version
live, which an agent's admins hold.

If the person keeps test cases built from the corrected runs, try the new
version on them first:

```sh
kindgi eval-runs start <test-set-id> --project=<project-id> \
  --agent=acme-store.refunds --agent-version=1.0.4 --wait
```

Where an expert said what the run should have done, its summary's
`corrections` says how many of those the version now passes (`passed` of
`checked`). No release gate policy checks it: quote it in the promote
`--reason`.

Either way, ask a person to make the new version live, naming the
corrections it fixes. Check first what will happen, then ask:

```sh
kindgi agents promote acme-store.refunds 1.0.4 --project=<project-id> --check
kindgi agents promote acme-store.refunds 1.0.4 --project=<project-id> \
  --reason="Fixes 1 correction: our return window is 14 days"
```

- The scope is `--tenant` (every project), `--org=<org-id>`, or
  `--project=<project-id> [--segment=<key:value>]…` (one project).
- `--check` changes nothing and answers whether it *would* make it live,
  needs an approval, or fails the release gate policy.
- `--reason` is kept on the record — write what the corrections were, so the
  approver reads the change in plain words.
- The outcome is `promoted`, or `pending-approval` when the scope's release
  gate policy has `approvals` and a second person must approve — the "a
  second person checks it" step, working as it should. (Whoever asked can't
  approve their own request, unless the policy sets `separateApprover: false`.)
- `--check` and the request exit 3 when the answer is no or the request
  waits for an approval. Read the printed outcome: exit 3 isn't an error.

## References

- Experts record corrections in the console, or with
  `kindgi judgments add --run=<run-id> --item=<key> --no --reason=<text>`.
- The guide for a person:
  <https://docs.kindgi.com/v0.3/guides/evals/fix-what-experts-corrected/>
- Letting Improve try wordings:
  <https://docs.kindgi.com/v0.3/guides/evals/improve-an-agent/>
- Changing a setting or a prompt by hand:
  <https://docs.kindgi.com/v0.3/guides/evals/change-a-prompt-or-setting/>
