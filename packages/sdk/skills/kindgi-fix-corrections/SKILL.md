---
name: kindgi-fix-corrections
description: >
  Turn the experts' corrections of a Kindgi agent into fixes. Load this when
  the person says "fix what the experts corrected", "the agent keeps getting
  <X> wrong, correct it", "turn the refund agent's corrections into changes",
  or points you at an agent's "no" judgments. The loop: pull the runs an
  expert marked wrong, read why, and sort each correction to where it belongs
  — a rule in code, a setting, an approval rule, or the agent's instructions —
  add a pack test per correction, then publish and ask a person to make the
  new version live, naming the corrections it fixes. Making a version live,
  approvals, and loosening a limit stay with the person; this never edits a
  refund limit down or removes an approval rule.
type: core
library: "@kindgi/sdk"
version: "0.1.0"
sdk_version: "0.0.0"
pack_languages: [node, python, java, scala]
sources:
  - packages/cli/src/commands/judgments.ts
  - packages/cli/src/commands/runs.ts
  - packages/cli/src/commands/blocks.ts
  - packages/cli/src/commands/agents.ts
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

1. **Never loosen a limit or a gate.** A refund limit and an approval rule
   are the "never" layer: they live in code and in approvals, and this skill
   never edits a limit down, removes a check, or removes an approval rule.
   Corrections only ever make the agent *stricter* or change how it talks.
2. **Making a version live is the person's.** You publish a new version and
   *ask* for it with `kindgi agents promote … --reason`. If an approval rule
   covers the scope, the promotion waits for a second person — don't try to
   get around it.
3. **The pulled runs hold real conversations.** A run you pull is a real
   customer's. Keep it out of git. Write every pack test with invented data
   — made-up order ids, amounts and names — never a customer's words or
   details. Never paste a whole run, or any customer's data, into the pack,
   a commit, or a message.

## Step 1 — Pull the corrections

The corrections are the agent's "no" judgments. List them for the version
the expert was correcting:

```sh
kindgi judgments list --agent=acme-store.refunds --agent-version=1.0.3 --verdict=no
```

- `--agent` and, optionally, `--agent-version` (it needs `--agent`). Without
  a version you get every version's.
- `--verdict=no` keeps only the corrections. (Leave it off to see what the
  experts confirmed as right, too.)
- `--class=<judge-class-id>` keeps only one judge class — use it to take
  only the experts' corrections once the project names its experts.

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

## Step 2 — Sort each correction to its layer

| The expert wrote | Where it belongs | How you change it |
|---|---|---|
| "Never refund shipping", "final sale: no refund" | a rule in **code** — the tool checks it every time | edit the tool and add a test (your language's `kindgi-authoring-tools`), then `kindgi deploy` |
| "Our return window is 14 days, not 30" | a **setting** the owner can change | publish the settings block, derive a version that pins it (Step 4) |
| "Over 50 on a first order: ask a person" | an **approval rule** | a person sets it (the owner or the approver) — never loosened in code; point them to it |
| "Store credit before cash", "too stiff", "say when the money arrives" | the agent's **instructions** (a judgment, or the words) | leave it to Improve, tried on the test cases (`kindgi proposals improve`, the `kindgi-using` and the improve guide) |

If a correction fits none of these, treat it as a code rule when it must
hold every time, and as instructions when it's a matter of judgment.

## Step 3 — Make the change, with a test per correction

Make each change in the layer you sorted it to, and add **one pack test per
correction** so the mistake can't come back:

- **Code (a tool):** add the check in the tool, and a test that the corrected
  case is now refused or handled right (the 20-day-old order is refused, the
  final-sale item isn't refunded). Follow your pack's language:
  `kindgi-authoring-tools` (TypeScript), `kindgi-python-authoring-tools`,
  `kindgi-java-authoring-tools`, or `kindgi-scala-authoring-tools`. Run the
  pack's tests the way that skill shows — `kindgi test` wraps `vitest` for a
  Node pack; a Python, Java or Scala pack runs its own test runner.
- **A setting:** decide the key, its limits and its default, and publish the
  settings block (Step 4). Add a test that the tool reads the setting and
  acts on it.
- **Instructions for Improve:** you don't write the prompt — you make sure the
  corrected cases are in a test set, then let a pass try wordings on them
  (`kindgi proposals improve`). The pass keeps a wording only if it does
  better on those cases.

Write tests with invented data (Step 1, rule 3). A correction that belongs
to the owner (a setting they'd rather own) or an approver (an approval rule)
is theirs to make — say so, and give them the one command or the console
page, don't do it for them.

## Step 4 — Publish, and ask to make it live

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
- `agents derive --setting=<block-id>=<version>` pins a block the version
  already uses to its new version. Repeat `--setting`/`--prompt` for several.

For a **code** change, `kindgi deploy` publishes the new version with the
changed tool.

Either way, ask a person to make the new version live, naming the
corrections it fixes. Check first what will happen, then promote:

```sh
kindgi agents promote acme-store.refunds 1.0.4 --project=<project-id> --check
kindgi agents promote acme-store.refunds 1.0.4 --project=<project-id> \
  --reason="Fixes 1 correction: our return window is 14 days"
```

- The scope is `--tenant` (every project), `--org=<org-id>`, or
  `--project=<project-id> [--segment=<key:value>]…` (one project).
- `--check` changes nothing and answers whether it *would* promote, needs an
  approval, or fails a gate.
- `--reason` is kept on the record — write what the corrections were, so the
  approver reads the change in plain words.
- The outcome is `promoted` or `pending-approval`. `pending-approval` means
  an approval rule covers the scope and a second person must approve — that's
  the "a second person checks it" step, working as it should.

## A worked example: the return window

An expert corrects a refund: "Shouldn't have refunded — delivered 20 days
ago, our window is 14." You pull it (Step 1), and see the window is a store
policy, not a one-off.

- **If the agent already reads a `returnWindowDays` setting:** publish the
  block with `returnWindowDays: 14` and derive a version that pins it
  (Step 4). Tell the owner they can change this themselves in the console.
- **If it doesn't:** add `returnWindowDays` to the store-policy settings
  block's schema (0–365, whole days), make the refund tool refuse an order
  delivered more than `returnWindowDays` ago and offer a person, and add a
  test: an order delivered 20 days ago is refused
  (`kindgi-authoring-tools`). Then `kindgi deploy`.

Then ask to make it live: `kindgi agents promote … --reason="Fixes 1
correction: our return window is 14 days"`. The limit — the most a refund
can be without a person — is never touched here: it stays in code and in the
approval rule.

## References

- Experts record corrections in the console, or with
  `kindgi judgments add --run=<run-id> --item=<key> --no --reason=<text>`.
- The guide for a person:
  <https://docs.kindgi.com/v0.1/guides/evals/fix-what-experts-corrected/>
- Letting a pass try wordings:
  <https://docs.kindgi.com/v0.1/guides/evals/improve-an-agent/>
- Changing a setting or a prompt by hand:
  <https://docs.kindgi.com/v0.1/guides/evals/change-a-prompt-or-setting/>
