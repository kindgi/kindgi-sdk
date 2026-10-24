---
title: Deploy your agent to Kindgi Cloud
description: Sign the Kindgi CLI in to your Kindgi Cloud workspace, sign the pack, give it your model key, deploy it with kindgi deploy --hosted, try it and go live. Then change an agent once it's live.
sidebar:
  order: 1
  label: Deploy your agent
---

This guide puts a pack of yours in your Kindgi Cloud workspace, in its
Default project, and then puts the project in production. Kindgi Cloud
builds the pack and runs it. On your machine, you need only the Kindgi CLI.

On Kindgi Cloud, your workspace's runtime reads its secrets and model
providers on `prod`, before and after you go live. So everything here uses
`--env=prod`.

## Before you start

- **A Kindgi Cloud workspace,** where you're an admin. Whoever
  [signs up](https://platform.kindgi.com/cloud/signup) is the workspace's
  first admin.
- **A pack with an agent,** with its tests passing, and the Kindgi skills
  that `kindgi init` installs in it. This guide uses the pack `acme-desk`,
  with the agent `acme-desk.reply-drafter`.
- **Kindgi 0.2's CLI,** with Node 22.12 or later. You don't need Docker:
  Kindgi Cloud builds the pack's image.
- **An API key from your AI provider,** with a spending limit.

## Sign the CLI in

Your coding agent deploys with the CLI's sign-in, so the key never goes
into the chat.

:::note[What only you do]
**Make a key for the CLI.** Sign in to the Kindgi Cloud console, at
[platform.kindgi.com/console](https://platform.kindgi.com/console/). Open
**API keys** and choose **Create a key**. Under **How far it goes**, choose
**Admin**. Under **What it can change**, tick **Trust signing keys** and
**Store secrets**. The secret shows once: **Copy** it.

This key is the one every command in this guide uses. If you also run
`kindgi dev`, its console and the token it prints belong to the runtime on
your machine, not to Kindgi Cloud: paste only the key you made here.

**Sign the CLI in, in a terminal of your own,** in the pack's folder. Paste
the key at the prompt, which doesn't show it:

```sh
read -rs KINDGI_API_TOKEN && export KINDGI_API_TOKEN
pnpm exec kindgi auth login --url=https://platform.kindgi.com
pnpm exec kindgi auth whoami
```

`auth whoami` checks the key with Kindgi Cloud. The CLI keeps the key in
`~/.kindgi/config.json`, for that address only.
:::

## Sign the pack

Kindgi Cloud deploys a pack only when it's signed with a key that your
workspace trusts.

Ask your coding agent: "Make a signing key for this pack, trust it in my
Kindgi Cloud workspace, and set it on the pack's `prod` environment." For
reference, that's two commands:

```sh
pnpm exec kindgi key create acme-desk --env=prod
pnpm exec kindgi key trust acme-desk
```

and the pack's `prod` environment in `kindgi.config.ts`. The config that
`kindgi init` writes has this block, commented out:

```ts excerpt
environments: {
  prod: {
    build: 'hosted',
    signingKey: '~/.kindgi/keys/acme-desk.pem',
  },
},
```

- `kindgi key create` writes the key pair to `~/.kindgi/keys/`. The private
  key stays on your machine.
- `kindgi key trust` adds its public key to your workspace's trust list.
  The CLI's key needs **Trust signing keys** for it.
- `build: 'hosted'` builds the pack on Kindgi Cloud.

## Your model key and its provider

Your agents call their model with your own key. The key and its provider
both go on `prod`.

:::note[What only you do]
**Store the key, in your own terminal.** With your AI provider, create an
API key for this pack. Then store it under the name the table below gives
for your provider, and paste it at the prompt, twice: the second time
confirms it.

```sh
pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=prod --scope=tenant
```

`--scope=tenant` makes it your whole workspace's key.
:::

Ask your coding agent: "Register my model provider on `prod`, with the key
I stored as `ANTHROPIC_API_KEY`." For reference:

```sh
pnpm exec kindgi providers register --preset=anthropic --env=prod
```

| Provider | Preset | The key's name |
| --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Gemini API | `gemini-api` | `GEMINI_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |

`kindgi providers presets` lists every preset.
[Models](../../guides/models/) has the rest, such as Bedrock, Vertex AI
and Azure OpenAI.

## Deploy

Ask your coding agent: "Deploy the pack to Kindgi Cloud, and wait until
its pack service is ready." For reference:

```sh
pnpm exec kindgi deploy --hosted --env=prod
```

- `--hosted` builds the pack on Kindgi Cloud, deploys what it built, and
  waits up to 5 minutes for its pack service to be ready, if it has one.
- `--env=prod` picks the `prod` environment: its signing key.
- With no `--project`, the pack goes into the Default project.
  `--project=<id-or-slug>` names another.

The deploy prints what it registered, with each agent's version, then
`Deploy complete.` and which image new runs use. Then it waits:
`Waiting for the pack service`, a `… <state>` line for each state it
waits in, and `✓ ready`.
A pack with no tools and no guardrail checks of its own, such as one of
agents and flows whose guardrails use only built-in checks, has no pack
service. Its deploy doesn't wait for one, and prints no `Waiting for the pack
service`.

## Try it

The project isn't in production yet, so its runs count as staging.

In the Kindgi Cloud console, open **Runs** and choose **Start run**. Under
**Agent or flow**, choose `acme-desk.reply-drafter`, write a message for it
under **Message**, and choose **Start run**. The run's page shows **What
happened**: each step, and then what the agent **Answered**.

From the CLI, the same run is:

```sh
pnpm exec kindgi runs start --agent=acme-desk.reply-drafter --input='{"userMessage":"Can I still return a jacket I bought five weeks ago?"}'
```

## Go live

Going live takes two steps, in this order.

**1. Make the agent's version live.** Until an agent has a live version,
each run gets its latest version, so every deploy changes what runs at
once. Make the version you tried live in the project. Then later deploys
change nothing until you promote again.

Ask your coding agent: "Make the version of `acme-desk.reply-drafter` that I
tried live in the Default project." For reference:

```sh
pnpm exec kindgi agents promote acme-desk.reply-drafter <version> --project=<project-id> --reason="The version we tried"
```

`kindgi projects list` lists the projects, with their ids. In the console,
the agent's **Live versions** page shows where each version is live.

**2. Put the project in production.**

:::note[What only you do]
**Go live.** Open the project's **Dashboard** in the console. On its
**Production** card, choose **Go live**, and **Go live** again to confirm.
Do this yourself: from then on, the project's runs are real work.
:::

The card then says **Live**, and since when.
[Organize by org and project](../../guides/projects/organize-by-org-and-project/)
says what being in production changes. How many projects can be in
production at once is in
[Kindgi Cloud's limits](../limits/#projects-in-production).

A project in production and an agent's live version are different things.
The project's **Go live** says that its runs are real work. An agent's live
version says which version those runs get.

## Change your agent once it's live

Your workspace has one environment, and an agent stays in the project it
was first deployed to. So you try a new version in the same project, by
its version, before you make it live.

1. **Deploy the new version** as before. The deploy prints its version
   number. While the agent has a live version, its runs keep getting that
   version.
2. **Try the new version by its version number.** In the console, choose
   it under **Version** in the **Start run** form. From the CLI, it's
   `kindgi runs start --agent=acme-desk.reply-drafter --agent-version=<new version> --input=…`.
   This is a real run, in a project in production. It uses your
   workspace's keys and secrets, and its tools do what they do.
3. **Compare it on a test set,** if you have one. A comparison replays the
   test set's cases with the new version
   ([Compare a version on a test set](../../guides/evals/compare-an-agent-version/)).
4. **Make it live:**
   `kindgi agents promote acme-desk.reply-drafter <new version> --project=<project-id> --reason=…`.
   Runs get it from the next run, except that a conversation that's
   already open keeps the version it started with
   ([Conversations keep their version](../../guides/evals/live-versions-reference/#conversations-keep-their-version)).
5. **Roll back if you need to:**
   `kindgi agents rollback acme-desk.reply-drafter --project=<project-id> --reason=…`.
   This puts back the version that was live before, at once.

Several new versions can wait at once. Each deploy that changes the code
registers a version, and you can run any of them by its number. Promoting
makes one of them live; the others stay, and you can still run them.

[Release an agent version](../../guides/evals/release-an-agent-version/)
shows each step, a release for some runs only, and a gate that needs a
reviewer.
[Live versions reference](../../guides/evals/live-versions-reference/) has
every rule and refusal.

### Secrets and keys aren't part of a version

A version holds the agent, not its values. Each run reads its secrets and
model keys when it runs, from your workspace's values on `prod`. So the live
version and every version that's waiting read the same values:

- A new secret that only the new version reads can go in before you
  promote.
- Changing a value that the live version reads changes live runs from the
  next run, before you promote anything.
- `kindgi deploy --hosted --env=prod --sync-secrets` writes the pack's
  `.env.prod` values right after the deploy, into those same values. So it
  can change what the live version reads, though you haven't promoted the
  new version.

## If something goes wrong

- **The deploy says `No signing key is set.`** The pack's `prod`
  environment has no `signingKey`. Set it as in
  [Sign the pack](#sign-the-pack), or pass `--signing-key`.
- **The deploy is refused with `signer-not-trusted`.** The signing key was
  never trusted, or it was revoked. Trust it with
  `kindgi key trust acme-desk`, then deploy again. A revoked key stays
  revoked: make a new one.
- **Trusting the key or storing the model key is refused.** The CLI's key
  lacks **Admin**, **Trust signing keys** or **Store secrets**. Make
  another key, as in [Sign the CLI in](#sign-the-cli-in), and sign the CLI
  in with it.
- **The pack service isn't ready after 5 minutes.** The deployment stays.
  `kindgi deployments get <deployment-id>` says its state, and why when
  a reason is recorded (`kindgi deployments list --table` lists your
  deployments, with their ids). Run the same
  `kindgi deploy --hosted --env=prod` again: it sends the same deployment
  and goes on waiting.
- **The Production card says `Going live isn't on for this tenant yet.`**
  If the card offers **See how to go live**, that link says what comes
  next. Until then, building and testing work as they are.
- **Going live is refused at the limit.** Take another project out of
  production first, or see
  [projects in production](../limits/#projects-in-production).

## What's next

- [Kindgi Cloud's limits](../limits/): the limits every workspace has, and
  how to ask for more.
- [A project for each client](../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project):
  give each client an org and a project, and deploy a pack of its own into
  it, made with `kindgi init`.
- [Ask before a tool runs](../../guides/approvals/ask-before-a-tool-runs/):
  a person approves before an agent changes something.
