---
name: kindgi-fix-corrections
description: >
  Turn the experts' corrections of a Kindgi agent into fixes. Load this when
  the person says "fix what the experts corrected", "the agent keeps getting
  <X> wrong, correct it", "turn the refund agent's corrections into changes",
  or points you at an agent's "no" corrections. The loop: pull the runs an
  expert marked wrong, read why, and sort each correction to where it belongs
  — a rule in code, a setting, an approval rule, or the agent's instructions —
  add a pack test per correction, then publish and ask a person to make the
  new version pinned, naming the corrections it fixes. Pinning a version
  and approving it stay with the person, and a correction that would loosen
  anything — raise a limit, widen a window, drop a check — goes to the owner,
  not the agent.
type: core
library: "@kindgi/sdk"
version: "0.2.1"
sdk_version: "0.0.0"
pack_languages: [node, python, java, scala]
sources:
  - packages/cli/src/commands/corrections.ts
  - packages/cli/src/commands/runs.ts
  - packages/cli/src/commands/blocks.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/test-runs.ts
  - packages/cli/src/commands/test.ts
---

# Fixing what the experts corrected

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm),
> `yarn kindgi …` or `bun run kindgi …`. A Python pack (`[tool.kindgi]` in
> `pyproject.toml`) has no Node project: run the `kindgi` on `PATH`. A Java
> or Scala pack (`kindgi.config.json`) runs the CLI it pins: `./kindgiw …`.
> Commands below are written `kindgi …` for brevity.

An expert — a support lead, a claims reviewer, an editor — marks a run's
answer wrong and says why. Your job is to turn those corrections into
changes to the agent, each at the layer where it belongs, so the agent
stops making the mistake and a person can see the mistake is gone.

A correction is not always a prompt change. A store's "never refund
shipping" belongs in the refund tool's code, where it's checked every time,
not in instructions a model may or may not follow. Sorting each correction
to the right layer is your call, not Kindgi's: Kindgi gives you the
corrections and the tools to change each layer.

## What stays with the person

1. **Never loosen a rule — a loosening correction goes to the owner.** Some
   corrections ask for a policy *looser* than the one in force: with a 14-day
   return window, "should have refunded — 20 days is fine for us" wants the
   window widened; others want a limit raised, a check dropped, or a tool to
   stop asking for approval. This skill makes none of those — it hands the
   correction to the owner, quoted, and lets them decide. A refusal the
   *current* rule already allows is not a loosening: the agent applied the rule
   wrong ("should have refunded — it was inside the 14 days"), nothing about the
   policy changes, so you fix it like any other correction — in code with a
   test, or in the instructions through Improve. The corrections you make carry
   out a rule the agent got wrong, tighten a rule, or change how the agent talks
   — never loosen the policy.
2. **Pinning a version is the person's.** You publish a new version and
   *ask* for it with `kindgi agents pin … --reason`. When the scope's
   release gate has `approvals`, the pin waits for a second person
   (`pending-approval`) — don't try to get around it.
3. **The pulled runs hold real conversations.** A run you pull is a real
   customer's. Keep it out of git. Write every pack test with invented data
   — made-up order ids, amounts and names — never a customer's words or
   details. Never paste a whole run, or any customer's data, into the pack,
   a commit, or a message.

## The loop

1. **Pull the corrections**: the pinned version's "no" corrections, each read
   in full with its run. [pull-corrections.md](pull-corrections.md)
2. **Sort each correction to its layer**: the table below.
3. **Make the change, with a test per correction.**
   [make-the-change.md](make-the-change.md)
4. **Publish, and ask a person to pin it**, with the guides to point
   people to. [publish-and-pin.md](publish-and-pin.md)

One correction taken through all four steps:
[worked-example.md](worked-example.md).

## Step 2 — Sort each correction to its layer

| The expert wrote | Where it belongs | How you change it |
|---|---|---|
| "Never refund shipping", "final sale: no refund", "over 50 on a first order, ask a person" | a rule in **code** — the tool checks it every time; a cap sends the case to a tool that always asks | edit the tool and add a test (your language's `kindgi-authoring-tools`), then `kindgi deploy` |
| "Our return window is 14 days, not 30" | a **setting** the owner can change | publish the settings block, derive a version that pins it (Step 4) |
| "Always have a person approve a refund" | an **approval rule** — a tenant policy that makes a tool always ask; it keys on the tool, not its arguments | a person sets it (the owner or the approver); point them to it, don't change it in code |
| "Store credit before cash", "too stiff", "say when the money arrives" | the agent's **instructions** | leave it to Improve, run on the test cases (`kindgi improve runs start`, the Improve guide in `publish-and-pin.md`) |

If a correction fits none of these, treat it as a code rule when it must
hold every time, and as instructions when it's a matter of correction.
