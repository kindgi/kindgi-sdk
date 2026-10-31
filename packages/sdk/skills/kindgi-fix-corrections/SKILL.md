---
name: kindgi-fix-corrections
description: >
  Turn the corrections people made to a Kindgi agent's runs into fixes. Load
  this when the person says "fix what the experts corrected", "the agent keeps
  getting <X> wrong", "work through the refund agent's corrections", or points
  you at an agent's open corrections. The loop: pull the open corrections, read
  each with its run, sort it to where it belongs — a rule in code, a setting,
  an approval rule, or the agent's wording — and fix it there. A setting or
  wording becomes a suggested change, checked on the agent's test set; a code
  fix goes through the repo with a pack test per correction. When a person
  pins the version, each correction it passes is marked Fixed. Pinning and
  approving stay with the person, and a correction that would loosen anything
  — raise a limit, widen a window, drop a check — goes to the owner, not the
  agent.
type: core
library: "@kindgi/sdk"
version: "0.3.0"
sdk_version: "0.0.0"
pack_languages: [node, python, java, scala]
sources:
  - packages/cli/src/commands/corrections.ts
  - packages/cli/src/commands/runs.ts
  - packages/cli/src/commands/suggested-changes.ts
  - packages/cli/src/commands/agents.ts
  - packages/cli/src/commands/improve-runs.ts
  - packages/cli/src/commands/test.ts
---

# Fixing what people corrected

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm),
> `yarn kindgi …` or `bun run kindgi …`. A Python pack (`[tool.kindgi]` in
> `pyproject.toml`) has no Node project: run the `kindgi` on `PATH`. A Java
> or Scala pack (`kindgi.config.json`) runs the CLI it pins: `./kindgiw …`.
> Commands below are written `kindgi …` for brevity.

A person — a support lead, a claims reviewer, an editor — corrects a run:
what the agent did wrong, and why. Your job is to fix each correction where
it belongs, so the agent stops making the mistake. Every correction is a case
in the agent's test set, so when a person pins the fixed version, Kindgi
checks it on those cases and marks each correction it passes **Fixed** in
that version, and a fix that breaks an earlier one shows up too.

## What stays with the person

1. **Never loosen a rule — that goes to the owner.** Some corrections ask
   for a looser policy: with a 14-day return window, "should have refunded —
   20 days is fine for us" wants the window widened; others want a limit
   raised, a check dropped, or a tool to stop asking for approval. Hand those
   to the owner, quoted. A refusal the *current* rule already allows is not a
   loosening ("it was inside the 14 days"): the agent applied the rule wrong,
   so fix it like any other correction.
2. **Pinning is the person's.** You make a suggested change and check it, or
   ask to pin a version, with a `--reason`. The project's release gate
   decides, and when it asks for a second person the pin waits
   (`waiting-for-second-person` or `pending-approval`): don't try to get
   around it. Won't fix is the person's call too: suggest it, with your
   reason.
3. **The pulled runs hold real conversations.** A run you pull is a real
   customer's. Keep it out of git. Write every pack test with invented data,
   never a customer's words or details, and never paste a run into the pack,
   a commit, or a message.

## The loop

1. **Pull the open corrections**, each with its run, and mark the ones you
   take. [pull-corrections.md](pull-corrections.md)
2. **Sort each one to its layer**: the table below.
3. **Fix it there.** A setting or the agent's wording:
   [suggest-a-change.md](suggest-a-change.md). A rule in code:
   [fix-in-code.md](fix-in-code.md).
4. **The pin**, what it checks, and Fixed in vN.
   [pin-and-fixed.md](pin-and-fixed.md)

One correction taken through the loop: [worked-example.md](worked-example.md).

## Sort each correction to its layer

| The person wrote | Where it belongs | How you fix it |
|---|---|---|
| "Never refund shipping", "final sale: no refund", "over 50 on a first order, ask a person" | a rule in **code**: the tool checks it every time | change the tool, with a test, through the repo |
| "Our return window is 14 days, not 30" | a **setting** the owner can change | a suggested change to the settings block |
| "Always have a person approve a refund" | an **approval rule**: a tenant policy that makes a tool always ask | a person sets it: point them to it |
| "Store credit before cash", "too stiff", "say when the money arrives" | the agent's **wording**, in its prompt block | an Improve run, or a suggested change when the person said exactly what to say |

Kindgi sorts each correction as it's saved (`sortedTo`): one that says the
decisions were wrong goes to the agent's owner, and one about the answer
alone goes to Improve. Take it as a first guess; the table decides the layer.
