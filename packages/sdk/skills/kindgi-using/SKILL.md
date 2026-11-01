---
name: kindgi-using
description: >
  Guide the person in using what was built with Kindgi: where things are in
  Kindgi's console (real links and the clicks) side by side with the
  answer from Kindgi's CLI in plain words. Load this when the person asks to see,
  find, check or understand something in Kindgi rather than build it:
  "show me around the console", "where do I see the answers it gave",
  "which orders did the agent look up", "which rule stopped that answer",
  "walk me through approving this", "what is the run waiting for",
  "what does Kindgi remember about <customer>", "when does the report run
  next", "is Kindgi healthy", "who has access", "the answers I rated",
  "what did each answer cost". Guiding is read-only: approving, connecting
  an app, erasing, adding people, pinning a version and rating stay
  with the person.
type: core
library: "@kindgi/sdk"
version: "0.1.5"
sdk_version: "0.0.0"
pack_languages: [node, python, java, scala]
---

# Guiding a person in using Kindgi

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm),
> `yarn kindgi …` or `bun run kindgi …`. A Python pack (`[tool.kindgi]` in
> `pyproject.toml`) has no Node project: run the `kindgi` on `PATH`. A Java
> or Scala pack (`kindgi.config.json`) runs the CLI it pins: `./kindgiw …`.
> Commands below are written `kindgi …` for brevity.

You built something with Kindgi; now the person wants to use it. Answer
what they ask with both, side by side: the answer from the `kindgi` CLI,
in plain words, and the console page that shows the same thing, with the
clicks, so they can see it for themselves.

## The rules

1. **Give both, briefly.** Start with the answer in one sentence. Then
   **In the CLI:** … and **In the console:** …, a few lines each. When one
   side has nothing for the question, say so in one line. Offer more
   detail instead of showing it ("Want the run-by-run breakdown?").
2. **Guiding is read-only.** You look things up and show where they are.
   Nothing you run here changes Kindgi.
3. **Some actions are the person's alone.** Never do these for them, even
   when asked: decide an approval (approve or reject), connect an app to
   their account, erase what Kindgi remembers about someone, add or
   remove people, grant or take away roles, create or revoke API keys,
   pin an agent version, correct an answer. Don't run their
   commands either, not even with a check or dry-run flag. Give the
   link and the clicks, then stop: they do it.
4. **Only through the CLI and the console.** The `kindgi` CLI signs in by
   itself. Never call Kindgi's API with a token read from a file, never
   open `.kindgirc.json` or env files, and never print a token.
5. **Write every link in full,** from `http` to the last id, so the person
   can click it: never `…/runs` or "the same address plus".
6. **Say the fields that answer the question.** Read the CLI's JSON and
   put what matters in words. A run carries a `publicAccessToken`: never
   paste a run, or any answer, whole.
7. **About one person, show only that person.** Asked about one
   customer, never show another's facts, runs or ratings, not even to
   prove a lookup works: check that quietly, and say only what is stored
   (or not) for the one they asked about.

## Links into the console

Build every link from three CLI answers:

| What | Command | Field |
|---|---|---|
| The console | `kindgi console --no-open` | the URL it prints, `<runtime>/console/` |
| The tenant | `kindgi auth whoami` | `identity.tenantId` |
| The project | `kindgi projects get-default` (or `kindgi projects list`) | `id` |

A project page is `<console>tenants/<tenantId>/projects/<projectId>/<page>`;
a tenant page is `<console>tenants/<tenantId>/<page>`. (The console itself
writes the tenant's short name there; the id opens the same pages.) If the
console asks the person to sign in first, they sign in and open the link
again.

An approval also has a short link, `<console>approvals/<approvalId>`: one
still waiting opens in the person's Inbox, chosen, ready to decide; a
decided one opens its own page.

### Project pages

| Page | `<page>` | Shows |
|---|---|---|
| Dashboard | *(empty)* | how the project is doing |
| Agents | `agents`, one: `agents/<agentId>`, `…/corrections` | the agents, their versions, which one is pinned |
| Runs | `runs` | every answer and flow run, newest first, with its cost |
| One run | `runs/<runId>`, with tabs `/journal`, `/provenance`, `/cost`, `/corrections` | the message, each tool it called with what it sent, the answer or what stopped it; then every step, what ran with what, what it cost, how it was rated |
| What failed | `runs/failures` | failed runs, grouped by why |
| Approvals | `approvals`, one: `approvals/<approvalId>` | what waits for a person's decision |
| Tools | `tools`, one: `tools/<toolId>` | the tools, what each may do and change |
| Guardrails | `guardrails`, one: `guardrails/<guardrailId>` | each rule's settings, the agents it checks, what it caught |
| Flows | `flows`, one: `flows/<flowId>` | the flows and their steps |
| Schedules | `schedules`, one: `schedules/<triggerId>` | when each runs next, and its past runs |
| Mail triggers | `mail-triggers`, one: `mail-triggers/<triggerId>` | the mailbox each watches and what it starts; its latest mails, and the run each started |
| Conversations | `conversations`, one: `conversations/<conversationId>` | each conversation's turns |
| Cost | `cost` | what the project's model calls cost, by agent, model, flow or kind |
| Corrections | `corrections` | runs to review (To review), corrections to fix (To fix), who corrects, rules, trends |
| An agent's test set | `agents/<agentId>/test-set` | each correction on its runs as a case, and cases added by hand |
| Suggested changes | `agents/<agentId>/suggested-changes`, one: `…/suggested-changes/<suggestedChangeId>` | changes to a prompt or settings for one project, each with its check |
| Pinned versions | `agents/<agentId>/pinned` | where each version is pinned, and the pin history |
| Evidence | `compliance` | the records kept for audits |
| Members | `members` | who has a role on this project |

The runs list filters by its URL: `agent=<agentId>`, `status=` one of
`pending`, `running`, `suspended`, `completed`, `failed`, `cancelled`,
and `since=` one of `1h`, `1d`, `7d`, `30d`. For example
`runs?agent=<agentId>&status=completed&since=1d` is every answer that
agent finished in the last day. The cost page takes `range=` one of `7d`,
`30d`, `90d`, `12m`, `agent=<agentId>` and `by=` one of `agent`, `model`,
`flow`, `kind`.

### Tenant pages

| Page | `<page>` | Shows |
|---|---|---|
| Home | *(empty)* | what needs a tenant admin's attention |
| Inbox | `inbox` | every approval the person may decide, across projects |
| People | `people`, one: `people/<userId>` | who is in, and what each may do |
| API keys | `api-keys` | the keys, who each acts as, when it expires |
| Service accounts | `service-accounts` | the accounts apps and pipelines act as |
| Teams | `teams` | the teams and their roles |
| Costs | `costs` | spend across every project |
| My access | `my-access` | what the signed-in person may do |

## When a customer was erased

When Kindgi erased what it kept about a customer, their runs keep their
record but not their words: a run with `contentErasedAt` has no message,
tool calls or answer any more. A correction of such a run keeps `decisions`
and `answer` and loses what it said (`why`, `shouldSay`, `shouldCall`,
`mustNotCall`). Say the words were erased with the customer's data; never
say there were none.

## Answering common questions

**"Show me around the console."**
- In the CLI: `kindgi console --no-open`, `kindgi auth whoami` and
  `kindgi projects get-default` give the address and the ids.
- In the console: the project's dashboard link, then the sections they
  will use: Runs, Approvals, Tools, Guardrails, Schedules, Cost, and the
  tenant's People.

**"Which tools are there, and what may each do?"**
- In the CLI: `kindgi tools list`: each tool's `id`, `description`, and
  whether it changes anything (`mutating`, and its `effects`).
- In the console: `tools`, and each tool's `tools/<toolId>`.

**"What did the agent look up for that answer?"**
- In the CLI: find the run with `kindgi runs list --agent <agentId>`
  (newest first; match the time), then `kindgi runs get <runId>`. Its
  `output.appended` holds the turn in order: the agent's `toolCalls` (each
  tool's `name` and `arguments`) and the `tool` messages with what came
  back. Say which records it looked up, and what it found.
- In the console: `runs/<runId>` shows each tool call and its arguments;
  the `/journal` tab has every step.

**"Where do I see every answer it finished in the last day?"**
- In the CLI: `kindgi runs list --agent <agentId> --limit 100`, keeping
  the runs whose `status` is `completed` and whose `createdAt` is in the
  last day (the CLI doesn't filter by status or time itself).
- In the console: `runs?agent=<agentId>&status=completed&since=1d`.

**"Which rule stopped that answer, and where is it set?"**
- In the CLI: `kindgi runs get <runId>`: a `status` of `failed` with
  `failure.code` `guardrail-violation`, and `failure.message` naming the
  guardrail and its reason. `kindgi guardrails get <guardrailId>` gives
  its settings.
- In the console: `runs/<runId>` shows what was blocked and by which
  guardrail; `guardrails/<guardrailId>` shows its settings, the agents it
  checks and what it caught.

**"Walk me through approving this."**
- In the CLI: `kindgi approvals list --status=pending` finds it: say what it asks for
  (`subjectKind`, the tool), and since when it waits.
- **One with an `approver` is addressed to one person:** its call acts
  with their own account in another app, which `connection` names
  (`appName`, `account`). Only they decide it. Say who it is
  (`approver.userId`; `kindgi people list` gives their name). When that
  isn't the person asking, don't walk them through deciding it: a tenant
  admin sees it, but any decision of theirs, escalating included, is
  refused (`403 named-approver-required`). Other reviewers don't see it
  at all. Its person approves or rejects it, but can't escalate it
  (`409 invalid-transition`). If they don't decide by its deadline, it
  expires.
- In the console: `<console>approvals/<approvalId>` opens it in the Inbox.
  Under **Your decision** they choose **Approve** or **Reject**, add a
  rationale if they like, and press the button. Then stop: the decision
  is theirs.

**"What is the run waiting for?"**
- In the CLI: `kindgi runs resume <runId>`, without `--output` (that
  answers the wait), says it in a sentence for each wait, and its exit
  code says which: `3` an approval, `5` another system's answer to a
  tool's call, `6` the person who started the run connecting an app, `4`
  the runtime itself (a queued start, a child run, a retry). Waiting on
  more than one, it exits with the first of `3`, `5`, `6`, `4` that
  applies. A connect's sentence names the app and what it asks for, and
  ends with when the link stops working and the link itself. Give that
  link in full and stop: only the person who started the run connects,
  from that link or the run's page, and the run goes on once they have.
  `kindgi runs get <runId>` prints the same line after the run's JSON
  (`waitingFor.connections`).
- In the console: `runs/<runId>` shows what it waits for, with a line per
  wait: **Open the approval**, or for a connect, what it asks to do and
  **Open the connect link**.

**"What does Kindgi remember about <a customer>?"**
- In the CLI: an agent that remembers for "the person you are talking
  with" keeps each fact under the conversation's participant, the
  customer's id in the app: `kindgi memory facts list --scope
  '{"participantId":"<their id>"}'`. Say each fact's `content` and when it
  was learned (`createdAt`). No facts means Kindgi remembers nothing about
  them, or it was erased.
- In the console: no page shows memory yet.

**"When does the report run next, and what did the last one say?"**
- In the CLI: `kindgi schedules list` finds it; `kindgi schedules get
  <triggerId> --upcoming 3` gives `nextFireAt` and `upcoming`;
  `kindgi schedules fires <triggerId>` lists past fires, newest first,
  each with its `runId`. `kindgi runs get <runId>` on the newest: its
  `status`, and its answer, `output.response.content`.
- In the console: `schedules/<triggerId>`, and the run's `runs/<runId>`.

**"What did the support inbox do with that mail?"**
- In the CLI: `kindgi mail-triggers list` finds the trigger; `kindgi
  mail-triggers fires <triggerId>` lists each new mail it found, newest
  first, with its `outcome` (`started`, `pending`, `skipped`, `refused` or
  `failed`), a `detail` saying why, and the `runId` it started. A
  `refused` mail never runs: staff handle it in the mailbox.
- In the console: `mail-triggers/<triggerId>` lists its latest mails, up
  to 50, what happened to each, and the run it started; an older one is
  in the CLI's `fires`. `runs?trigger=<triggerId>` is every run it
  started. The run is `runs/<runId>`.

**"Is Kindgi healthy?"**
- In the CLI: `kindgi health` (`"ok": true` when the server answers) and
  `kindgi doctor` (each part, with a fix for any that fail).
- In the console: no page shows health yet.

**"Who has access right now?"**
- In the CLI: `kindgi people list`, and `kindgi people grants <userId>`
  for what each may do; `kindgi service-accounts list`; `kindgi tokens
  list` for the API keys.
- In the console: the tenant's `people`, `service-accounts` and
  `api-keys`, and a project's `members`.

**"Show me the answers I rated."**
- In the CLI: `kindgi auth whoami` gives `identity.principal`;
  `kindgi corrections list` lists ratings, newest first: keep those whose
  `madeBy` is that principal (same `kind` and `id`), and say each
  one's run, `answer` and `why`. In `kindgi dev`, the CLI and the
  console's sign-in are the same seed user.
- In the console: each run's `runs/<runId>/corrections`, and `corrections`.

**"What are people correcting, and what's being fixed?"**
- In the CLI: `kindgi corrections list --agent=<agentId> --status=not-fixed`
  (each one's `status`, and its `link` once someone took it), and
  `kindgi suggested-changes list --agent=<agentId>` (each change's
  `status`: its check, then pinned or added as Latest).
- In the console: `corrections` (To fix), and the agent's
  `agents/<agentId>/corrections` and `…/test-set`.

**"What did each answer cost this week?"**
- In the CLI: one answer at a time: `kindgi runs get <runId>`, its
  `output.usage.totalCostUsd` (the model calls). There is no command for a
  week's total.
- In the console: `runs?agent=<agentId>&since=7d` (each run's cost is a
  column), and `cost?range=7d&agent=<agentId>` for the total; one run's
  breakdown is `runs/<runId>/cost`.

## More

- Runs: https://docs.kindgi.com/v0.3/guides/runs/list-runs/ and
  https://docs.kindgi.com/v0.3/guides/runs/read-the-journal/
- Approvals: https://docs.kindgi.com/v0.3/guides/approvals/decide-an-approval/
- Connections: https://docs.kindgi.com/v0.3/guides/connections/use-a-connection/
- Memory: https://docs.kindgi.com/v0.3/guides/agents/give-an-agent-memory/
- Schedules: https://docs.kindgi.com/v0.3/guides/runs/run-on-a-schedule/
- Mail triggers: https://docs.kindgi.com/v0.3/guides/runs/start-runs-from-new-mail/
- People and keys: https://docs.kindgi.com/v0.3/deploy/people-and-keys/
- Cost: https://docs.kindgi.com/v0.3/guides/observability/cost-per-run/
- Rating answers: https://docs.kindgi.com/v0.3/guides/improve/correct-a-runs-output/
