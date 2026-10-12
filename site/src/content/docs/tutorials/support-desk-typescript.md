---
title: Build a support desk (TypeScript)
description: Tools over your own code, an agent with a typed answer, and a flow that acts on it, in one TypeScript pack.
sidebar:
  order: 1
---

You'll build the first line of a support desk. An agent reads a ticket,
classifies it, sets its priority and drafts a reply. A flow then escalates
the urgent tickets and records a reply on the rest.

Along the way, you'll write two tools over your own code, one that reads and
one that writes. You'll also write an agent with a typed answer, and a flow
that branches on that answer. It takes about 20 minutes.

## Before you start

- **Node 22.12 or later**, and **pnpm**.
- **Docker**, with access to the runtime image, as
  [Install](../../start/install/) sets up.
- **An API key from an AI model provider** (Anthropic, OpenAI, Gemini, Groq
  or OpenRouter), for step 6.

## 1. Create the pack

A pack is the folder Kindgi runs your code from. Create one from the
`minimal` template, and install its dependencies:

```sh tutorial=run
npx @kindgi/cli init acme-desk --template=minimal
cd acme-desk
pnpm install
```

- `acme-desk` is the pack's name, and the folder it's created in.
- `--template=minimal` starts the pack with its folders and nothing in them.

`init` lists the files it made, and `pnpm install` installs the pack's
packages. You now have the pack's folders, `tools/`, `agents/`, `guardrails/`
and `flows/`, all empty.

## 2. Your code

The tools will work on tickets. In your app, tickets would come from a
database. Here they come from a small module of the pack's own, so the
tutorial runs anywhere. Write it:

```ts tutorial=write
// src/tickets.ts
// Your app's code: here, an in-memory ticket store.
export interface Ticket {
  id: string;
  customer: string;
  subject: string;
  body: string;
  notes: string[];
}

const tickets = new Map<string, Ticket>([
  ['T-100', { id: 'T-100', customer: 'Ada', subject: 'Charged twice', body: 'My card was charged twice for the March invoice.', notes: [] }],
  ['T-101', { id: 'T-101', customer: 'Grace', subject: 'Locked out', body: 'Production is down for my team: nobody can log in since this morning.', notes: [] }],
]);

export function getTicket(id: string): Ticket | undefined {
  return tickets.get(id);
}

export function addNote(id: string, note: string): number {
  const ticket = tickets.get(id);
  if (!ticket) throw new Error(`No ticket ${id}`);
  ticket.notes.push(note);
  return ticket.notes.length;
}
```

The pack now has two tickets, `T-100` and `T-101`, and functions to read
one and add a note to it.

## 3. Two tools

Tools are how an agent or a flow reaches your code. Write two.

The first tool reads a ticket. It changes nothing, and says so with
`mutating: false`:

```ts tutorial=write
// tools/get-ticket/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

import { getTicket } from '../../src/tickets.js';

const defined = defineTool({
  id: 'acme-desk.get-ticket' as ToolId,
  description: 'Reads a support ticket by its id (T-123).',
  version: '0.1.0',
  input: z.object({ ticketId: z.string() }),
  output: z.object({
    found: z.boolean(),
    customer: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
  }),
  effects: [],
  mutating: false,
  handler: async ({ ticketId }) => {
    const ticket = getTicket(ticketId);
    return ticket
      ? { found: true, customer: ticket.customer, subject: ticket.subject, body: ticket.body }
      : { found: false };
  },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

The other adds a note to a ticket. It writes, so it doesn't say
`mutating: false`, and `effects` names what it writes:

```ts tutorial=write
// tools/add-note/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

import { addNote } from '../../src/tickets.js';

const defined = defineTool({
  id: 'acme-desk.add-note' as ToolId,
  description: 'Adds an internal note to a ticket.',
  version: '0.1.0',
  input: z.object({ ticketId: z.string(), note: z.string().min(1) }),
  output: z.object({ notes: z.number() }),
  effects: [{ kind: 'writes', resource: 'tickets' }],
  handler: async ({ ticketId, note }) => ({ notes: addNote(ticketId, note) }),
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

A tool imports your code like any other module, with the `.js` extension the
pack's TypeScript settings ask for.

The pack now has two tools: `get-ticket` reads a ticket, and `add-note`
writes to one.

## 4. An agent with a typed answer

The agent reads a ticket with `get-ticket`, and answers in a shape your flow
can act on. Write it:

```ts tutorial=write
// agents/triage/index.ts
import { defineAgent } from '@kindgi/sdk/define';
import type { AgentId, Semver } from '@kindgi/sdk/types';
import { z } from 'zod';

const defined = defineAgent({
  id: 'acme-desk.triage' as AgentId,
  version: '0.1.0' as Semver,
  name: 'Triage',
  description: 'Classifies a support ticket and drafts a first reply.',
  instructions: [
    'You triage support tickets. Read the ticket with the get-ticket tool, then answer',
    'with its category (billing, access or other), its priority (low, normal or urgent)',
    'and a short, friendly first reply to the customer.',
    'A ticket is urgent when the customer cannot work at all.',
  ].join(' '),
  capabilities: [{ needs: [{ feature: 'tool-use' as const }] }],
  tools: [{ id: 'acme-desk.get-ticket', version: '^0.1.0' }],
  retrieval: [],
  guardrails: [],
  output: {
    schema: z.object({
      category: z.enum(['billing', 'access', 'other']),
      priority: z.enum(['low', 'normal', 'urgent']),
      reply: z.string(),
    }),
  },
  budget: { maxSteps: 4, maxCostUsd: 0.05, maxWallMs: 60_000 },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

`output` is the answer's shape. The model has to answer with JSON that fits
it. An answer that doesn't fit is sent back once, with what's wrong. If it
still doesn't fit, the turn fails.

The pack now has an agent whose answer always has a `category`, a `priority`
and a `reply`.

## 5. A flow that acts on the answer

The flow runs the agent, then escalates the ticket or records the reply,
depending on the agent's answer. Write it:

```ts tutorial=write
// flows/handle-ticket/index.ts
import { defineFlow } from '@kindgi/sdk/define';

const isUrgent = {
  op: 'eq',
  left: { path: 'nodeOutputs.triage.output.priority' },
  right: { literal: 'urgent' },
} as const;

const defined = defineFlow({
  id: 'acme-desk.handle-ticket',
  version: '0.1.0',
  name: 'Handle a ticket',
  description: 'Triages a ticket, then escalates it or records the drafted reply.',
  nodes: [
    {
      id: 'triage',
      kind: 'agent',
      ref: 'acme-desk.triage',
      inputMapping: { ticketId: { path: 'runInput.ticketId' } },
    },
    {
      id: 'escalate',
      kind: 'tool',
      ref: 'acme-desk.add-note',
      inputMapping: {
        ticketId: { path: 'runInput.ticketId' },
        note: { literal: 'Escalated to the on-call engineer.' },
      },
    },
    {
      id: 'record-reply',
      kind: 'tool',
      ref: 'acme-desk.add-note',
      inputMapping: {
        ticketId: { path: 'runInput.ticketId' },
        note: { path: 'nodeOutputs.triage.output.reply' },
      },
    },
  ],
  edges: [
    { id: 'start', from: '$start', to: 'triage' },
    { id: 'urgent', from: 'triage', to: 'escalate', when: isUrgent },
    { id: 'not-urgent', from: 'triage', to: 'record-reply', when: { op: 'not', child: isUrgent } },
    { id: 'escalated', from: 'escalate', to: '$end' },
    { id: 'recorded', from: 'record-reply', to: '$end' },
  ],
  output: {
    mapping: {
      category: { path: 'nodeOutputs.triage.output.category' },
      priority: { path: 'nodeOutputs.triage.output.priority' },
      reply: { path: 'nodeOutputs.triage.output.reply' },
    },
  },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

- The `triage` step runs the agent on the run's `ticketId`.
- Two edges leave it, each with a `when`: `escalate` runs when the agent said
  `urgent`, `record-reply` when it didn't. Both call `add-note`, with
  different inputs.
- `output` is what the run returns: three fields of the agent's answer.

Check that everything compiles:

```sh tutorial=run
pnpm exec tsc --noEmit
```

It prints nothing when everything compiles. The pack is complete.

## 6. Run it

`kindgi dev` starts the runtime and loads your pack. Start it:

```sh tutorial=background ready="Kindgi is up"
pnpm exec kindgi dev
```

```text tutorial=expect
✓ loaded: 2 tools, 0 guardrails, 1 agents, 1 flows
```

It has loaded the pack's two tools, its agent and its flow. Leave it
running, and continue in a second terminal, in `acme-desk`.

The agent needs a real model for its typed answer. The stand-in that
`kindgi dev` starts with can't produce one. Store your AI model provider's
API key as a secret, then register the provider:

```sh
pnpm exec kindgi secrets set <KEY_NAME> --env=local --scope=tenant
pnpm exec kindgi providers register --preset=<preset>
```

`<KEY_NAME>` and `<preset>` depend on the provider:

| Provider | `<KEY_NAME>` | `<preset>` |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Gemini (a Google AI Studio key) | `GEMINI_API_KEY` | `gemini-api` |
| Groq | `GROQ_API_KEY` | `groq` |
| OpenRouter (a hosted gateway) | `OPENROUTER_API_KEY` | `openrouter` |

- `secrets set` prompts for the key, and doesn't echo it.
- `--env=local` is the environment the secret belongs to. Under
  `kindgi dev`, `local` is the pack's env files.
- `--scope=tenant` is where the secret lives: the tenant, rather than one
  org (`org:<orgId>`) or project (`project:<projectId>`).
- `--preset=<preset>` registers the provider's models from Kindgi's built-in
  preset, which reads the `<KEY_NAME>` secret.

`secrets set` then prints the secret's name, scope, environment and version
as JSON, then `Set <KEY_NAME> at tenant in local.` `providers register`
prints the provider's id as JSON, then `✓ Registered <preset>:` with the
preset's models, its default marked. Your agent's turns now go to that
provider's default model.

## 7. Triage a ticket

Running the agent on its own shows its answer before the flow acts on it:

```sh
pnpm exec kindgi runs start --agent=acme-desk.triage --input='{"userMessage":"Triage ticket T-101"}'
```

- `--agent=acme-desk.triage` is the agent to run.
- `--input` is the turn's input, as JSON: `userMessage` is what the agent is
  asked.

It prints the run, with the agent's answer in `output`:

```text
  "status": "completed",
…
    "output": {
      "reply": "Hi Grace,\n\nThank you for reaching out. I'm sorry to hear your team is locked out and production is down. …",
      "category": "access",
      "priority": "urgent"
    },
```

The agent called `get-ticket`, read the ticket, and answered in the shape
you gave it. Your reply will read differently, because it's the model's. To
see the run's page, with each step, the tool call and the cost, run
`pnpm exec kindgi console` and open **Runs**.

## 8. Handle tickets

The flow acts on the agent's answer. Run it once for each ticket:

```sh
pnpm exec kindgi runs start --flow=acme-desk.handle-ticket --input='{"ticketId":"T-100"}'
pnpm exec kindgi runs start --flow=acme-desk.handle-ticket --input='{"ticketId":"T-101"}'
```

`--flow` is the flow to run, and `--input` its run's input. Each prints its
run, with the flow's output:

```text
  "output": {
    "reply": "Hi Ada,\n\nThank you for reaching out! I'm sorry to hear that your card was charged twice …",
    "category": "billing",
    "priority": "normal"
  },
…
  "output": {
    "reply": "Hi Grace,\n\nThank you for reaching out, and I'm sorry to hear your team is locked out of production! …",
    "category": "access",
    "priority": "urgent"
  },
```

The journal shows which way each run went. For `T-101`:

```sh
pnpm exec kindgi runs journal <run-id>
```

`<run-id>` is the `id` that `T-101`'s `runs start` printed. Its journal shows
the `triage` step, then `escalate`:

```text
      "kind": "step.completed",
      "nodeId": "triage",
…
      "kind": "step.completed",
      "nodeId": "escalate",
```

`T-100` went through `record-reply` instead, and its ticket now has the
drafted reply as a note.

You've built a pack whose agent triages tickets and whose flow acts on its
answer.

## Next

- [Call it from your app](../../start/existing-app/#starting-runs-from-your-app):
  start the flow from your own code and read its output.
- [Ask before a tool runs](../../guides/approvals/ask-before-a-tool-runs/):
  have a person approve the escalation first.
- [Get a webhook when a run finishes](../../guides/webhooks/receive-run-finished/):
  hear about each ticket's run when it ends.
