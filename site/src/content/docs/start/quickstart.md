---
title: Quickstart
description: An empty folder, one command, and four prompts to your coding agent, to an agent that answers.
sidebar:
  order: 1.5
---

From an empty folder to an agent that answers. You run one command, and your
coding agent does the rest.

**You need** Node 22.12 or later, Docker running, and a coding agent such as
Claude Code. Kindgi's runtime image needs access too: sign in at
[access.kindgi.com](https://access.kindgi.com) with GitHub, and run the
`kindgi auth registry` command it shows. [Install](../install/) has the
details.

## 1. Make the project

In an empty folder:

```sh
npx --yes @kindgi/cli init my-agents
```

It makes the project in a new folder, `my-agents`, and gives your coding
agent Kindgi's skills, in `my-agents/.claude/skills/` and
`my-agents/.agents/skills/`:

```text
…
✓ Pack scaffolded at …/my-agents/
✓ package.json pins pnpm@10.28.0 (packageManager)
…
```

## 2. Ask your coding agent

Open `my-agents` in your coding agent. Send it these prompts, one at a time:

1. `Install this project's dependencies and start Kindgi in the background.`
2. `Connect a real model.`
3. `Write an agent that reads a customer message and says how urgent it is, and why.`
4. `Run it with: "My order hasn't arrived and I need it tomorrow."`

At the second prompt, your coding agent asks which AI model provider you
use. Then it gives you a command that stores the provider's API key, to run
yourself, in a terminal in `my-agents`. For Anthropic, it's:

```sh
pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
```

For another provider, it's the same command with that provider's key name,
such as `OPENAI_API_KEY`. It asks for the key twice, and shows it neither
time, so the key never goes into the chat:

```text
Value:
Re-enter to confirm:
```

If your coding agent asks you to paste the key into the chat, or to put it
in a file, run the command instead. Then tell your coding agent it's done:
it registers the provider, with `kindgi providers register` and the
provider's preset, such as `--preset=anthropic`.

## Find the console

The console shows each run: what the agent was asked, the steps it took and
what it answered. When Kindgi starts, it prints the console's address:

```text
    Console    http://127.0.0.1:4000/console/   (open in your browser)
```

Your coding agent started it, so ask it: `What's the console's address?`
The port is `4000`, or the next free one. On the sign-in page, click
**Sign in as seeded user**.

## Next

- [Your coding agent](../coding-agents/): what else to ask it, and how it
  knows Kindgi.
- [Quickstart: TypeScript](../quickstart-typescript/): the same steps, by
  hand. Also in [Python](../quickstart-python/), [Java](../quickstart-java/)
  and [Scala](../quickstart-scala/).
- [Add Kindgi to an existing app](../existing-app/).
