---
title: Build a support desk (Python)
description: Tools over your own code, an agent with a typed answer, and a flow that acts on it, in one Python pack.
sidebar:
  order: 2
---

You'll build the first line of a support desk. An agent reads a ticket,
classifies it, sets its priority and drafts a reply. A flow then escalates
the urgent tickets and records a reply on the rest.

Along the way, you'll write two tools over your own code, one that reads and
one that writes. You'll also write an agent with a typed answer, and a flow
that branches on that answer. It takes about 20 minutes.

## Before you start

- **Python 3.11 or later**, and **uv**.
- **Docker**, with access to the runtime image, as
  [Install](../../start/install/) sets up.
- **An API key from an AI model provider** (Anthropic, OpenAI, Gemini, Groq
  or OpenRouter), for step 6.

## 1. Create the pack

A pack is the folder Kindgi runs your code from. Create one from the
`python` template, remove the template's example, add a package for your own
code, and install the dependencies:

```sh tutorial=run
uvx --from "kindgi-cli>=0.2,<0.3" kindgi init acme-desk --template=python
cd acme-desk
rm tools/echo.py tools/greet.py agents/echo_agent.py flows/echo_flow.py guardrails/response_not_empty.py tests/test_tools.py
mkdir support && touch support/__init__.py
uv sync
```

- `uvx --from "kindgi-cli>=0.2,<0.3"` runs the Kindgi 0.2 CLI without
  installing it.
- `acme-desk` is the pack's name, and the folder it's created in.
- `--template=python` starts a Python pack, with a small example.

`init` lists the files it made, and `uv sync` installs the dependencies. The
other commands print nothing. You now have the pack's folders, `tools/`,
`agents/`, `guardrails/` and `flows/`, and the `[tool.kindgi]` tables in
`pyproject.toml`, without the example. `support/` is where your code goes.

## 2. Your code

The tools will work on tickets. In your app, tickets would come from a
database. Here they come from a small module of the pack's own, so the
tutorial runs anywhere. Write it:

```python tutorial=write
# support/tickets.py
"""Your app's code: here, an in-memory ticket store."""

from dataclasses import dataclass, field


@dataclass
class Ticket:
    id: str
    customer: str
    subject: str
    body: str
    notes: list[str] = field(default_factory=list)


_TICKETS = {
    "T-100": Ticket("T-100", "Ada", "Charged twice", "My card was charged twice for the March invoice."),
    "T-101": Ticket("T-101", "Grace", "Locked out", "Production is down for my team: nobody can log in since this morning."),
}


def get_ticket(ticket_id: str) -> Ticket | None:
    return _TICKETS.get(ticket_id)


def add_note(ticket_id: str, note: str) -> int:
    ticket = _TICKETS[ticket_id]
    ticket.notes.append(note)
    return len(ticket.notes)
```

The pack now has two tickets, `T-100` and `T-101`, and functions to read
one and add a note to it.

## 3. Two tools

Tools are how an agent or a flow reaches your code. Write two, in one file.
`get_ticket` changes nothing, and says so with `mutating=False`. `add_note`
writes, so it doesn't say that, and `effects` names what it writes:

```python tutorial=write
# tools/tickets.py
from pydantic import BaseModel, Field

from kindgi import tool
from support.tickets import add_note as store_note
from support.tickets import get_ticket as find_ticket


class TicketRef(BaseModel):
    ticket_id: str = Field(alias="ticketId")


class TicketView(BaseModel):
    found: bool
    customer: str | None = None
    subject: str | None = None
    body: str | None = None


class Note(BaseModel):
    ticket_id: str = Field(alias="ticketId")
    note: str = Field(min_length=1)


class NoteCount(BaseModel):
    notes: int


@tool(id="acme-desk.get-ticket", mutating=False)
def get_ticket(input: TicketRef) -> TicketView:
    """Reads a support ticket by its id (T-123)."""
    ticket = find_ticket(input.ticket_id)
    if ticket is None:
        return TicketView(found=False)
    return TicketView(found=True, customer=ticket.customer, subject=ticket.subject, body=ticket.body)


@tool(id="acme-desk.add-note", effects=[{"kind": "writes", "resource": "tickets"}])
def add_note(input: Note) -> NoteCount:
    """Adds an internal note to a ticket."""
    return NoteCount(notes=store_note(input.ticket_id, input.note))
```

The pack's root is on `sys.path`, so a tool imports your code by its package
name, `support.tickets`.

The pack now has two tools: `get_ticket` reads a ticket, and `add_note`
writes to one.

## 4. An agent with a typed answer

The agent reads a ticket with `get_ticket`, and answers in a shape your flow
can act on. Write it:

```python tutorial=write
# agents/triage.py
from typing import Literal

from pydantic import BaseModel

from kindgi import Agent

from ..tools.tickets import get_ticket


class Triage(BaseModel):
    category: Literal["billing", "access", "other"]
    priority: Literal["low", "normal", "urgent"]
    reply: str


triage = Agent(
    id="acme-desk.triage",
    version="0.1.0",
    name="Triage",
    description="Classifies a support ticket and drafts a first reply.",
    instructions=(
        "You triage support tickets. Read the ticket with the get-ticket tool, then answer "
        "with its category (billing, access or other), its priority (low, normal or urgent) "
        "and a short, friendly first reply to the customer. "
        "A ticket is urgent when the customer cannot work at all."
    ),
    capabilities=[{"needs": [{"feature": "tool-use"}]}],
    tools=[get_ticket],
    output=Triage,
    budget={"maxSteps": 4, "maxCostUsd": 0.05, "maxWallMs": 60_000},
)
```

`output` is the answer's shape. The model has to answer with JSON that fits
it. An answer that doesn't fit is sent back once, with what's wrong. If it
still doesn't fit, the turn fails.

The pack now has an agent whose answer always has a `category`, a `priority`
and a `reply`.

## 5. A flow that acts on the answer

The flow runs the agent, then escalates the ticket or records the reply,
depending on the agent's answer. Write it:

```python tutorial=write
# flows/handle_ticket.py
from kindgi import Flow

from ..agents.triage import triage
from ..tools.tickets import add_note

IS_URGENT = {
    "op": "eq",
    "left": {"path": "nodeOutputs.triage.output.priority"},
    "right": {"literal": "urgent"},
}

handle_ticket = Flow(
    id="acme-desk.handle-ticket",
    version="0.1.0",
    name="Handle a ticket",
    description="Triages a ticket, then escalates it or records the drafted reply.",
    nodes=[
        {
            "id": "triage",
            "kind": "agent",
            "ref": triage,
            "inputMapping": {"ticketId": {"path": "runInput.ticketId"}},
        },
        {
            "id": "escalate",
            "kind": "tool",
            "ref": add_note,
            "inputMapping": {
                "ticketId": {"path": "runInput.ticketId"},
                "note": {"literal": "Escalated to the on-call engineer."},
            },
        },
        {
            "id": "record-reply",
            "kind": "tool",
            "ref": add_note,
            "inputMapping": {
                "ticketId": {"path": "runInput.ticketId"},
                "note": {"path": "nodeOutputs.triage.output.reply"},
            },
        },
    ],
    edges=[
        {"id": "start", "from": "$start", "to": "triage"},
        {"id": "urgent", "from": "triage", "to": "escalate", "when": IS_URGENT},
        {"id": "not-urgent", "from": "triage", "to": "record-reply", "when": {"op": "not", "child": IS_URGENT}},
        {"id": "escalated", "from": "escalate", "to": "$end"},
        {"id": "recorded", "from": "record-reply", "to": "$end"},
    ],
    output={
        "mapping": {
            "category": {"path": "nodeOutputs.triage.output.category"},
            "priority": {"path": "nodeOutputs.triage.output.priority"},
            "reply": {"path": "nodeOutputs.triage.output.reply"},
        },
    },
)
```

- The `triage` step runs the agent on the run's `ticketId`.
- Two edges leave it, each with a `when`: `escalate` runs when the agent said
  `urgent`, `record-reply` when it didn't. Both call `add_note`, with
  different inputs.
- `output` is what the run returns: three fields of the agent's answer.

Check what Kindgi finds in the pack. The indexer lists every tool, agent and
flow it loads:

```sh tutorial=run
uv run python -m kindgi.pack index --pack-dir .
```

```text tutorial=expect
  "counts": {
    "tools": 2,
    "guardrails": 0,
    "agents": 1,
    "flows": 1
  },
…
  "fileErrors": []
```

## 6. Run it

```sh tutorial=background ready="Kindgi is up"
uv run kindgi dev
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
uv run kindgi secrets set <KEY_NAME> --env=local --scope=tenant
uv run kindgi providers register --preset=<preset>
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
- `--scope=tenant` is where the secret lives: the workspace, rather than one
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
uv run kindgi runs start --agent=acme-desk.triage --input='{"userMessage":"Triage ticket T-101"}'
```

- `--agent=acme-desk.triage` is the agent to run.
- `--input` is the turn's input, as JSON: `userMessage` is what the agent is
  asked.

It prints the run, with the agent's answer in `output`:

```text
  "status": "completed",
…
    "output": {
      "reply": "Hi Grace, thank you for reaching out. I'm sorry to hear your team is locked out of production. …",
      "category": "access",
      "priority": "urgent"
    },
```

The agent called `get_ticket`, read the ticket, and answered in the shape you
gave it. Your reply will read differently, because it's the model's. To see
the run's page, with each step, the tool call and the cost, run
`uv run kindgi console` and open **Runs**.

## 8. Handle tickets

The flow acts on the agent's answer. Run it once for each ticket:

```sh
uv run kindgi runs start --flow=acme-desk.handle-ticket --input='{"ticketId":"T-100"}'
uv run kindgi runs start --flow=acme-desk.handle-ticket --input='{"ticketId":"T-101"}'
```

`--flow` is the flow to run, and `--input` its run's input.

The first returns `"category": "billing"`, `"priority": "normal"` and a
drafted reply. The second returns `"category": "access"` and
`"priority": "urgent"`.

The journal shows which way each run went. For `T-101`, where `<run-id>` is
the `id` that its `runs start` printed:

```sh
uv run kindgi runs journal <run-id>
```

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
