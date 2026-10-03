---
title: "Quickstart: TypeScript"
description: Create a pack with tools, an agent, a guardrail and a flow, run it on your machine, and connect a real model.
sidebar:
  order: 3
  label: "Quickstart: TypeScript"
---

In ten minutes: a pack with two tools, an agent that calls them, a guardrail
on its answers and a flow, running on your machine. You need Node 22 and
Docker ([Install](../install/)).

:::note[Private preview]
The runtime image is in private preview: request access at contact@kindgi.com.
:::

## 1. Create the pack

```sh
npx @kindgi/cli init my-pack --template=sample
cd my-pack
pnpm install
```

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

(The default template, `minimal`, gives you the folders and none of the
examples.)

## 2. Run it

```sh
pnpm exec kindgi dev
```

`kindgi dev` starts the Kindgi runtime in Docker, indexes the pack,
registers every tool, agent, guardrail and flow, and does it again on every
save. It prints the API's URL and a token, and writes them to
`.kindgirc.json` in the pack, so the commands below find the runtime by
themselves. Leave it running.

## 3. Run the agent

In a second terminal, in `my-pack`:

```sh
pnpm exec kindgi runs start --agent=my-pack.echo-agent --input='{"userMessage":"hi"}'
```

There's no model yet, so the answer comes from `dev-echo`, a stand-in a new
pack gets: it calls the agent's first tool and replies with what the tool
returned, and the run carries a `fallback-provider` warning. That's enough
to see the whole path: the agent's turn, the tool call into your code, the
guardrail's check.

## 4. Run the flow

```sh
pnpm exec kindgi runs start --flow=my-pack.echo-flow --input='{"name":"Ada"}'
```

The flow greets the name with the `greet` tool, then hands the greeting to
the agent and returns both. Add `--dry-run` to see which steps would run
without running the tools that change anything.

## 5. Look at the code

A tool is a typed function. Its input and output are schemas, checked on
every call:

```ts
// tools/echo/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

const defined = defineTool({
  id: 'my-pack.echo' as ToolId,
  description: 'Echoes the caller-provided message with a UTC timestamp + character count.',
  version: '0.1.0',
  input: z.object({ message: z.string().min(1).max(500) }),
  output: z.object({ echo: z.string(), echoedAt: z.string(), characterCount: z.number() }),
  effects: [],
  handler: async (input) => ({
    echo: input.message,
    echoedAt: new Date().toISOString(),
    characterCount: input.message.length,
  }),
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

The agent is data: its instructions, the tools it may call, the guardrails
on its answers, its budget. Change a file and save; `kindgi dev` picks it
up.

## 6. Connect a real model

Put an Anthropic key in the pack's `.env`, then register the provider:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env
pnpm exec kindgi providers register --preset=anthropic
```

It takes over from `dev-echo` at the next turn. Run the agent again and it
answers with a real model, still calling your tools. Gemini on Vertex AI
has a preset too (`--preset=gemini --project=<gcp-project>`); any
OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, OpenRouter) registers
from a short spec file.

## Next

- [Tutorials](../../tutorials/): build something real, step by step.
- [Guides](../../guides/): one task at a time: tools, agents, flows,
  models, secrets, webhooks, deploying.
- [Set up your coding agent](../coding-agents/): it already has Kindgi's
  skills.
