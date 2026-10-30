# A worked example: the return window

An expert corrects a refund: "Shouldn't have refunded — delivered 20 days
ago, our window is 14." You pull it (Step 1, `pull-corrections.md`), and see the window is a store
policy, not a one-off.

- **If the agent already reads a `returnWindowDays` setting:** suggest a
  change to the block with `returnWindowDays: 14` (Step 4,
  `publish-and-promote.md`). Tell the owner they can change this themselves in
  the console.
- **If it doesn't read one yet:** this is a code change, in two parts. First
  publish the settings block with the key — `returnWindowDays` in its schema
  (0–365, whole days) and `14` in its values — because a deploy that references
  a block with no published version is refused ("publish the block first").
  Then, in code, make the refund tool read `returnWindowDays` and refuse an
  order delivered more than that many days ago (offering a person), add the
  block to what the agent references, and add a test: an order delivered 20
  days ago is refused (`kindgi-authoring-tools`). `kindgi deploy` publishes the
  version with the new reference. (A suggested change only changes a block the
  version already pins, so it can't introduce this one — the deploy does.) The schema and value live outside the pack and outside code review, so
  show them to the person and name them in the `--reason`.

Then ask to make it live: `kindgi agents promote … --reason="Fixes 1
correction: our return window is 14 days"`. The refund limit — the most a
refund can be without a person — is never raised here: the cap stays in the
tool's code, and the large-refund tool still always asks.
