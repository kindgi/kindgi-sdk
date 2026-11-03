# Step 3 — A rule in code: fix it through the repo

A rule that must hold every time goes in the tool's code, where it's checked
on every call, not in wording a model may or may not follow.

1. **Change the tool, with one pack test per correction.** Add the check,
   and a test that the corrected case is now refused or handled right: the
   20-day-old order is refused, the final-sale item isn't refunded. Take
   what the test asserts from the correction (`shouldCall`, `mustNotCall`,
   `shouldSay`), with invented data. Follow your pack's language:
   `kindgi-authoring-tools` (TypeScript), `kindgi-python-authoring-tools`,
   `kindgi-java-authoring-tools` or `kindgi-scala-authoring-tools`, and run
   the pack's tests the way that skill shows (`kindgi test` wraps `vitest`
   in a Node pack).
2. **Open a pull request**, and mark each correction it fixes `being-fixed`
   with the pull request's URL as the `--link` (Step 1). A person reviews and
   merges it.
3. **The deploy makes the new version.** After the merge, `kindgi deploy`,
   or the person's CI, publishes it:
   - **A project that runs its Latest** runs it at once, and Kindgi checks
     it on that project's test set.
   - **A project that runs a pin** gets it as a suggested change, made by
     the deploy and checked like any other. Find it with
     `kindgi suggested-changes list --agent=<agent-id> --project=<project-id> --status=ready`,
     and ask to pin it with `kindgi suggested-changes pin <id> --reason=…`.

## A new setting the code reads

When the fix needs a setting that doesn't exist yet, such as a return
window the owner can change, it's a code change in two parts, both in the
pack:

- **The block's file** in `blocks/`: add the key to the settings block's
  `schema` (its type and limits) and `values`, and give the block a new
  `version`. `kindgi deploy` publishes the pack's blocks before the agents
  that use them.
- **The code** reads the key, and the agent takes the block in its
  `settings`. Your language's `kindgi-authoring-agents` shows the agent's
  side.

A key that Improve may change gets `"x-kindgi-tunable": true` in the
schema, on a number with a `minimum` and `maximum`, or on an `enum` of two
or more values. Leave it off a key that guards a rule: a limit, a window, a
cap.

A correction that belongs to the owner (a setting they'd rather own) or an
approver (an approval rule) is theirs to make: say so, and give them the one
command or the console page.
