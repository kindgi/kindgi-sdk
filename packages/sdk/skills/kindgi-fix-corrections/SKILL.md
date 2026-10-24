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
  new version live, naming the corrections it fixes. Making a version live
  and approving it stay with the person, and a correction that would loosen
  anything — raise a limit, widen a window, drop a check — goes to the owner,
  not the agent.
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
  - packages/cli/src/commands/eval-runs.ts
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
2. **Making a version live is the person's.** You publish a new version and
   *ask* for it with `kindgi agents promote … --reason`. When the scope's
   release gate policy has `approvals`, the promotion waits for a second person
   (`pending-approval`) — don't try to get around it.
3. **The pulled runs hold real conversations.** A run you pull is a real
   customer's. Keep it out of git. Write every pack test with invented data
   — made-up order ids, amounts and names — never a customer's words or
   details. Never paste a whole run, or any customer's data, into the pack,
   a commit, or a message.

## Step 1 — Pull the corrections

The corrections are the agent's "no" judgments. Start from the version the
agent is running now, so you don't re-fix something an earlier version already
fixed:

```sh
kindgi agents live acme-store.refunds --project=<project-id>
```

`agents live` shows the version a run would use for the project (and
`agents live-versions` lists every scope with a live version). List that
version's "no" judgments — and, as you work through them, newer versions':

```sh
kindgi judgments list --agent=acme-store.refunds --agent-version=1.0.3 --verdict=no
```

- `--agent-version` (it needs `--agent`) scopes to one version — the live one,
  to start. Older versions' corrections may already be fixed; without a version
  you get every version's.
- `--verdict=no` keeps only the corrections. (Leave it off to see what the
  experts confirmed as right, too.)
- `--class=<judge-class-id>` keeps only one judge class — use it to take
  only the experts' corrections once the project names its experts.

Kindgi doesn't hand out corrections: two people's coding agents can pull the
same "no" judgments, so agree outside Kindgi who takes which before you start.

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

An expert can also have said exactly what the run should have done (runtime
0.2.0 or later): the judgment then has a `correction`, with `calls` (each
`{ tool, args }`, with only the argument fields that matter) and `notCalled`
(the tools it shouldn't have called). Take those as what the pack test
asserts. It's the expert's: never record or change a correction yourself.
Test cases built from the run check each new version against it.

## Step 2 — Sort each correction to its layer

| The expert wrote | Where it belongs | How you change it |
|---|---|---|
| "Never refund shipping", "final sale: no refund", "over 50 on a first order, ask a person" | a rule in **code** — the tool checks it every time; a cap sends the case to a tool that always asks | edit the tool and add a test (your language's `kindgi-authoring-tools`), then `kindgi deploy` |
| "Our return window is 14 days, not 30" | a **setting** the owner can change | publish the settings block, derive a version that pins it (Step 4) |
| "Always have a person approve a refund" | an **approval rule** — a tenant policy that makes a tool always ask; it keys on the tool, not its arguments | a person sets it (the owner or the approver); point them to it, don't change it in code |
| "Store credit before cash", "too stiff", "say when the money arrives" | the agent's **instructions** | leave it to Improve, run on the test cases (`kindgi proposals improve`, the improve guide) |

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
  corrected cases are in the test cases, then let an Improve run try wordings
  on them (`kindgi proposals improve`). It writes a *suggested* change only
  when a wording does better on those cases, and a person
  decides whether to take it; nothing is applied on its own.

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

## A worked example: the return window

An expert corrects a refund: "Shouldn't have refunded — delivered 20 days
ago, our window is 14." You pull it (Step 1), and see the window is a store
policy, not a one-off.

- **If the agent already reads a `returnWindowDays` setting:** publish the
  block with `returnWindowDays: 14` and derive a version that pins it
  (Step 4). Tell the owner they can change this themselves in the console —
  Edit as a new version, then Derive a version.
- **If it doesn't read one yet:** this is a code change, in two parts. First
  publish the settings block with the key — `returnWindowDays` in its schema
  (0–365, whole days) and `14` in its values — because a deploy that references
  a block with no published version is refused ("publish the block first").
  Then, in code, make the refund tool read `returnWindowDays` and refuse an
  order delivered more than that many days ago (offering a person), add the
  block to what the agent references, and add a test: an order delivered 20
  days ago is refused (`kindgi-authoring-tools`). `kindgi deploy` publishes the
  version with the new reference. (`agents derive` only re-pins a block the
  version already references, so it can't introduce this one — the deploy
  does.) The schema and value live outside the pack and outside code review, so
  show them to the person and name them in the `--reason`.

Then ask to make it live: `kindgi agents promote … --reason="Fixes 1
correction: our return window is 14 days"`. The refund limit — the most a
refund can be without a person — is never raised here: the cap stays in the
tool's code, and the large-refund tool still always asks.

## References

- Experts record corrections in the console, or with
  `kindgi judgments add --run=<run-id> --item=<key> --no --reason=<text>`.
- The guide for a person:
  <https://docs.kindgi.com/v0.1/guides/evals/fix-what-experts-corrected/>
- Letting Improve try wordings:
  <https://docs.kindgi.com/v0.1/guides/evals/improve-an-agent/>
- Changing a setting or a prompt by hand:
  <https://docs.kindgi.com/v0.1/guides/evals/change-a-prompt-or-setting/>
