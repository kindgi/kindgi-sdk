---
title: Deploy your first agent
description: From sign-up to a project in production on Kindgi Cloud. Your coding agent writes an agent of your own, tests it and deploys it, and you try it in the console and put it live.
sidebar:
  order: 1
---

An agent of your own runs on Kindgi Cloud, in a project in production. Your
coding agent writes it, tests it and deploys it. You hand over the keys, try
the agent in Kindgi's console, and put it live. Nothing of Kindgi's runs on
your machine but the Kindgi CLI.

The agent here drafts replies to customers' messages from a shop's
policies. To make another agent, describe it in chapter 2 instead: the other
steps stay the same.

**What you'll build,** one chapter at a time:

1. your Kindgi Cloud workspace, with the Kindgi CLI signed in to it;
2. your agent, written and tested on your machine;
3. the agent on Kindgi Cloud;
4. a first run, started from the console;
5. the project in production.

**You need:**

- **A coding agent** that can run commands in a folder on your machine:
  Claude Code, Cursor, Codex or similar.
- **Node 22.12 or later.** Docker isn't needed: nothing of Kindgi's runs on
  your machine.
- **An API key from your AI provider** (Anthropic, OpenAI, Gemini, Groq or
  OpenRouter), made for this guide, with a spending limit.

What the agent writes reads differently for you: your model writes it.

## 1. Your Kindgi Cloud workspace

### The goal

A workspace of your own on Kindgi Cloud, and the Kindgi CLI on your machine
signed in to it, so your coding agent can deploy to it.

:::note[What only you do]
**Sign up.** Open
[Kindgi Cloud's sign-up page](https://platform.kindgi.com/cloud/signup) and
follow its steps. When your workspace is ready, an email says so, with a
link to sign in to its console. You're the workspace's first admin.

**Make a key for the CLI.** In the console, open **API keys** and **Create
a key**. Under **How far it goes**, choose **Admin**. Under **What it can
change**, tick **Trust signing keys** and **Store secrets**, then choose
**Create key**. The key shows once: **Copy** it.

**Sign the CLI in, in a terminal of your own.** Paste the key at the prompt,
which doesn't show it:

```sh
read -rs KINDGI_API_TOKEN && export KINDGI_API_TOKEN
npx --yes @kindgi/cli@0.1 auth login --url=https://platform.kindgi.com
npx --yes @kindgi/cli@0.1 auth whoami
```

`auth whoami` shows who the key acts as: you. The CLI keeps the key in
`~/.kindgi/config.json`, and your coding agent uses that sign-in from then
on. The key itself never goes into the chat.
:::

### See it in Kindgi's console

**Dashboard** shows your workspace's default project, **Default**. Your
agent goes there in chapter 3.

```text
CAPTURE: the console's Dashboard for a new workspace
```

## 2. Your agent

### The goal

A Kindgi pack on your machine with an agent of your own in it, and its
tests passing:

- **the reply drafter** (`acme-desk.reply-drafter`): given a customer's
  message, it drafts a short reply for someone on your staff to send. It
  holds to the shop's policies and never promises what they don't say;
- **the policies tool** (`acme-desk.policies`): it reads the shop's
  policies, and changes nothing.

### Ask your coding agent

Open your coding agent in an empty folder, and paste:

```text
Make a Kindgi pack with `npx --yes @kindgi/cli@0.1 init acme-desk`, then read its README and AGENTS.md and install it as the README says. Then, as the Kindgi skills it installed say:
- Write a read-only tool `acme-desk.policies` that returns my shop's policies: returns within 30 days, with the receipt; refunds go back to the card that paid, within 5 business days; no price matching. Give it a test.
- Write an agent `acme-desk.reply-drafter`. Given a customer's message, it drafts a short, polite reply for someone on my staff to send. It reads the policies with `acme-desk.policies` and never promises what they don't say.
- Run the pack's tests with `kindgi test`.
The pack runs on Kindgi Cloud later, so there's no `kindgi dev`. Tell me when the tests pass, and what you made.
```

Use your shop's own policies in place of these.

### What your agent should say

It wrote the tool and the agent, each in a folder of its own, and the
tests pass:

```text
CAPTURE: the coding agent's summary, with kindgi test passing
```

<details>
<summary>Under the hood: what your coding agent made</summary>

Abridged: `package.json`, `README.md` and `AGENTS.md` are left out.

```text
acme-desk/
├── kindgi.config.ts                  # the pack, and where it deploys
├── tools/policies/index.ts           # the shop's policies (read-only)
├── tools/policies/index.test.ts      # the tool's test
├── agents/reply-drafter/index.ts     # the agent: what it does, its tool, its budget
├── .claude/skills/                   # the Kindgi skills your coding agent follows
└── .agents/skills/                   # the same skills, for other coding agents
```

</details>

## 3. Your agent on Kindgi Cloud

### The goal

The pack in your workspace's default project, with your model key, signed
with a key of yours. Kindgi Cloud deploys a pack only when a key your
workspace trusts signed it.

### Ask your coding agent

In the same chat, paste:

```text
Deploy the pack to my Kindgi Cloud workspace, where the Kindgi CLI is already signed in:
- First my model key, for the provider I name. Take it from my clipboard into `kindgi secrets set <its key's name> --env=prod --scope=tenant --from-stdin` when I say I've copied it, and never print it. Then register that provider on `prod` with `kindgi providers register --preset=<its preset> --env=prod`, as the kindgi-authoring-providers skill says.
- Make a signing key with `kindgi key create acme-desk`, and trust it with `kindgi key trust acme-desk`.
- Deploy the pack to the default project with `kindgi deploy --hosted --env=prod`, signing with that key, and wait until the deploy says the pack service is ready.
Tell me whenever you need something from me, and wait for me. At the end, tell me the agent's id.
```

:::note[What only you do]
**Hand over your model key, without pasting it into the chat.** With your
AI provider, create an API key for this guide, and copy it. When your
coding agent asks which provider, answer with its name and "copied":
"Anthropic, copied", say. The agent moves the key from your clipboard
straight into Kindgi Cloud, which keeps it in your workspace's secrets.
:::

### What your agent should say

`kindgi deploy --hosted` builds the pack on Kindgi Cloud, streams the
build, deploys what it built, and waits until the pack service is ready:

```text
CAPTURE: kindgi deploy --hosted for acme-desk, from the build to the pack service ready
```

### See it in Kindgi's console

In the default project:

- **Tools:** the policies tool, `acme-desk.policies`.
- **Agents:** the reply drafter, `acme-desk.reply-drafter`.

```text
CAPTURE: the console's Agents for acme-desk on Kindgi Cloud
```

## 4. A first run

### The goal

The reply drafter's first draft, from a run you start in the console. The
project isn't in production yet, so the run counts as staging: a test.

### Start it in Kindgi's console

Open **Runs** and **Start run**. Under **Agent or flow**, choose the reply
drafter (`acme-desk.reply-drafter`). Under **Message**, write a customer's
message:

```text
Hi, I bought a jacket five weeks ago and it doesn't fit. Can I still return it?
```

Then choose **Start run**.

### See it in Kindgi's console

The run's page opens. Under **What happened**, the agent reads the
policies with `acme-desk.policies`. Then, under **Answered**, comes its
draft, which holds to the 30 days.

```text
CAPTURE: the run's page, with the policies read and the draft
```

## 5. In production

### The goal

The project in production, so its runs are real work, not tests.

:::note[What only you do]
**Go live.** In the console, open the project's **Dashboard**. Use **Go
live** on its **Production** card, and **Go live** again to confirm. Do
this yourself: it's the step that makes the agent's work real, so it's a
person's decision.
:::

### See it in Kindgi's console

The **Production** card says **Live**, and since when. Runs from then on
count as live. **Take out of production**, on the same card, makes the
project's runs staging again.

How many of your projects can be in production at once is in
[Kindgi Cloud's limits](../limits/#projects-in-production).

## If something looks wrong

- **The Production card says going live isn't on for this tenant yet.** Its
  **See how to go live** link says what comes next. Until then, building
  and testing work as they are.
- **Going live is refused at the limit of projects in production.** Take
  another project out of production first, or see
  [projects in production](../limits/#projects-in-production).
- **The deploy says the runtime doesn't trust the signing key**
  (`signer-not-trusted`). The key was never trusted, or it was revoked. Ask
  your coding agent to trust it with `kindgi key trust acme-desk`, then
  deploy again.
- **Trusting the key or storing the model key is refused.** The CLI's key
  is missing **Admin**, **Trust signing keys** or **Store secrets**. Make
  another key as in chapter 1, and sign the CLI in with it.
- **The pack service isn't ready after 5 minutes.** The deployment stays in
  place. Ask your coding agent to run the same `kindgi deploy --hosted
  --env=prod` again: it goes on waiting.
- **The run fails with `secret-not-found`.** The model key and the provider
  are on different environments. Ask your coding agent to put both on
  `prod`.

## What's next

- [Kindgi Cloud's limits](../limits/): the limits every account has, and how
  to ask for more.
- **A project for each client:** give each client an org and a project, and
  deploy a copy of the pack into it
  ([organize by org and project](../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)).
- [Ask before a tool runs](../../guides/approvals/ask-before-a-tool-runs/):
  a person approves before an agent changes something.
- [Build a support desk](../../tutorials/support-desk-typescript/): tools
  over your own code, an agent with a typed answer, and a flow that acts on
  it.
