# Step 4 — Publish, and ask to make it live

For a **setting** change, suggest a change for the project the corrections
came from — no code change:

```sh
kindgi suggested-changes create --agent=acme-store.refunds --project=<project-id> \
  --block=acme.store-policy --values=@store-policy.json \
  --why="Our return window is 14 days" --fixes=<correction-id>
```

- `--block` names a block the version the project runs *already* pins.
  `--values` is a settings block's new values, checked against its schema;
  `--template` is a prompt block's new instructions instead. Either takes a
  file as `@<file>`.
- `--why` says what it fixes, and each `--fixes` names a correction it fixes.
- It publishes the block version, makes the agent version that pins it, and
  tries both versions on the project's test cases. Read the new version from
  its output's `version` rather than assuming one. The same change again
  answers the suggested change made before: don't make another.

For a **code** change, `kindgi deploy` publishes the new version with the
changed tool.

A suggested change needs `publish` on the agent, and promoting needs `promote` — the permission that makes a version
live, which an agent's admins hold.

If the person keeps test cases built from the corrected runs, try the new
version on them first:

```sh
kindgi test-runs start <test-set-id> --project=<project-id> \
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
  `kindgi corrections add --run=<run-id> --item=<key> --no --reason=<text>`.
- The guide for a person:
  <https://docs.kindgi.com/v0.3/guides/evals/fix-what-experts-corrected/>
- Letting Improve try wordings:
  <https://docs.kindgi.com/v0.3/guides/evals/improve-an-agent/>
- Changing a setting or a prompt by hand:
  <https://docs.kindgi.com/v0.3/guides/evals/change-a-prompt-or-setting/>
