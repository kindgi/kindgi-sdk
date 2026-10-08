---
title: "Quickstart: TypeScript"
description: Create a pack with tools, an agent, a guardrail and a flow, run it on your machine, and connect a real model.
sidebar:
  order: 3
  label: "Quickstart: TypeScript"
---

In ten minutes: a pack with two tools, an agent that calls them, a guardrail
on its answers and a flow, running on your machine.

**Before you start**, set up what the [Install page](../install/) describes:
Node 22.12, Docker, and access to the runtime image: sign in at
[access.kindgi.com](https://access.kindgi.com) with GitHub, copy your pull
token, then log in once with `kindgi auth registry`.

## 1. Create the pack

```sh tutorial=run
npx @kindgi/cli init my-pack --template=sample
cd my-pack
pnpm install
```

:::note[On Kindgi 0.1.0 (fixed in 0.1.1)]
`init` from npm writes no `.gitignore`, so git would track `.env` (where
your model key goes) and `.kindgirc.json` (the dev token). Before your first
commit:

```sh
printf '%s\n' node_modules/ dist/ .kindgi/ .kindgirc.json '*.tsbuildinfo' .env .env.local >> .gitignore
```
:::

`my-pack` is the pack's id: every tool, agent and flow in it is named
`my-pack.<name>`. The `sample` template gives you:

```
my-pack/
├── kindgi.config.ts                    # the pack's id, version and folders
├── tools/echo/index.ts                 # a tool: echoes a message
├── tools/greet/index.ts                # a tool: greets a name
├── tools/fetch-httpbin/index.ts        # a tool that calls an HTTP API
├── agents/echo-agent/index.ts          # an agent that calls the tools
├── guardrails/response-not-empty/      # a check on the agent's answers
├── flows/echo-flow/index.ts            # a flow: a tool step, then the agent
└── .claude/skills/                     # skills for your coding agent
```

:::tip[Or ask your coding agent]
The pack already has Kindgi's skills in `.claude/skills/`. Follow the steps
below yourself, or ask your coding agent ("run the pack and try the agent",
"add a tool that looks up an order"): the skills tell it which commands to
run. [How it knows Kindgi](../coding-agents/).
:::

(The default template, `minimal`, gives you the folders and none of the
examples.)

## 2. Run it

```sh tutorial=background ready="Kindgi is up"
pnpm exec kindgi dev
```

`kindgi dev` starts the Kindgi runtime in Docker, indexes the pack,
registers every tool, agent, guardrail and flow, and does it again on every
save. It prints the API's URL and a token, and writes them to
`.kindgirc.json` in the pack, so the commands below find the runtime by
themselves. Leave it running.

## 3. Run the agent

In a second terminal, in `my-pack`:

```sh tutorial=run
pnpm exec kindgi runs start --agent=my-pack.echo-agent --input='{"userMessage":"hi"}'
```

```text tutorial=expect
  "status": "completed",
…
⚠ dev-echo answered, and it isn't a real model: it only repeats what it's given. …
```

There's no model yet, so the answer comes from `dev-echo`, a stand-in a new
pack gets: it calls the agent's first tool with `{"message": <your
userMessage>}` and replies with what the tool returned, after a first line
that says it isn't a real model. The run carries the `fallback-provider` and
`dev-echo-not-a-model` warnings, and the command prints the second on its
stderr, with how to add a key. That's enough to see the whole path: the agent's
turn, the tool call into your code, the guardrail's check.

:::caution[dev-echo checks the wiring, nothing more]
It can't fill in any other tool input, and it can't produce a typed answer
(an agent with an `output` schema fails with `output-schema-violation`).
Connect a model ([step 6](#6-connect-a-real-model)) before you write an agent
of your own.
:::

## 4. Run the flow

```sh tutorial=run
pnpm exec kindgi runs start --flow=my-pack.echo-flow --input='{"name":"Ada"}'
```

```text tutorial=expect
  "status": "completed",
…
    "greeting": "Hello, Ada!"
```

The flow greets the name with the `greet` tool, then hands the greeting to
the agent and returns both. Add `--dry-run` to see which steps would run
without running the tools that change anything.

## 5. Look at the code

A tool is a typed function. Its input and output are schemas, checked on
every call:

```ts
// tools/greet/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

const GreetInput = z.object({
  name: z.string().min(1).max(100),
  greeting: z.string().min(1).max(50).default('Hello'),
});

const GreetOutput = z.object({
  message: z.string(),
});

const defined = defineTool({
  id: 'my-pack.greet' as ToolId,
  description: 'Formats a greeting for the named recipient.',
  version: '0.1.0',
  input: GreetInput,
  output: GreetOutput,
  effects: [],
  mutating: false,
  handler: async (input) => ({
    message: `${input.greeting}, ${input.name}!`,
  }),
});

if (defined.kind === 'err') {
  throw new Error(`my-pack.greet failed to compile: ${defined.error.message}`);
}

export default defined.value;
```

`mutating: false` says the tool changes nothing, so a dry run calls it and
approval gates don't stop it by default. Leave it out for a tool that writes,
sends or charges anything: a tool is treated as changing something unless it
says otherwise. `effects` names what a tool does outside your code (writes,
network calls), for policies and the audit trail.

The agent is data: its instructions, the tools it may call, the guardrails
on its answers, its budget. Change a file and save; `kindgi dev` picks it
up.

## 6. Connect a real model

Store an Anthropic key as a secret (you're prompted for it; it isn't
echoed, and it goes in the pack's `.env.local`), then register the provider:

```sh
pnpm exec kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
pnpm exec kindgi providers register --preset=anthropic
```

It takes over from `dev-echo` at the next turn. Run the agent again and it
answers with a real model, still calling your tools. Gemini on Vertex AI
has a preset too (`--preset=gemini --project=<gcp-project>`); any
OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, OpenRouter) registers
from a short spec file.

The registration is in this project's dev database. To have `kindgi dev`
register the model on every boot, in each worktree and after `--reset`,
declare it in `kindgi.config.ts`: [Declare them in your pack's config](../../guides/models/#declare-them-in-your-packs-config).

## Next

- [Build a support desk](../../tutorials/support-desk-typescript/): tools
  over your own code, a typed answer, a flow that acts on it.
- [Guides](../../guides/): one task at a time: tools, agents, models, flows,
  runs, webhooks, approvals, secrets.
- [Add Kindgi to an existing app](../existing-app/): your app's own code
  as tools, and your app starting runs.
- [Concepts](../../concepts/): packs, runs and the journal, security.
- [Set up your coding agent](../coding-agents/): it already has Kindgi's
  skills.
