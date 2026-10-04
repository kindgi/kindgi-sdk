---
title: Build a support desk (Python)
description: Tools over your own code, an agent with a typed answer, and a flow that acts on it, in one Python pack.
sidebar:
  order: 2
---

You'll build the first line of a support desk: an agent reads a ticket,
classifies it, sets its priority and drafts a reply, and a flow escalates the
urgent tickets and records a reply on the rest. Along the way you'll write
two tools over your own code (one that reads, one that writes), an agent with
a typed answer, and a flow that branches on that answer.

You need Python 3.11 or later with uv, Node 22 (for the CLI), Docker with
access to the runtime image ([Install](../../start/install/)), and an
Anthropic API key for step 6. About 20 minutes.

## 1. Create the pack

```sh tutorial=run
npx --yes @kindgi/cli@0.1 init acme-desk --template=python
cd acme-desk
rm tools/echo.py tools/greet.py agents/echo_agent.py flows/echo_flow.py guardrails/response_not_empty.py tests/test_tools.py
mkdir support && touch support/__init__.py
uv sync
```

The `python` template comes with a small example; you removed it, and kept
the folders (`tools/`, `agents/`, `guardrails/`, `flows/`) and the
`[tool.kindgi]` tables in `pyproject.toml`. `support/` is where your code goes.

:::note[On Kindgi 0.1.0 (fixed in 0.1.1)]
`init` from npm writes no `.gitignore`, so git would track `.env` files
(where model keys go) and `.kindgirc.json` (the dev token):

```sh
printf '%s\n' .venv/ __pycache__/ .kindgi/ .kindgirc.json .env '.env.*' >> .gitignore
```
:::

## 2. Your code

The tools will work on tickets. In your app they'd come from a database; here
it's a small module of the pack's own, so the tutorial runs anywhere:

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

## 3. Two tools

One file, two tools. `get_ticket` changes nothing, and says so with
`mutating=False`; `add_note` writes, so it doesn't, and `effects` names what
it writes:

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
name (`support.tickets`).

## 4. An agent with a typed answer

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
        "You triage support tickets. Read the ticket with `acme-desk.get-ticket`, then answer "
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
it; an answer that doesn't is sent back once with what's wrong, and the turn
fails if it still doesn't fit.

## 5. A flow that acts on the answer

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

Check what Kindgi finds in the pack:

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
npx --yes @kindgi/cli@0.1 dev
```

```text tutorial=expect
✓ loaded: 2 tools, 0 guardrails, 1 agents, 1 flows
```

Leave it running, and continue in a second terminal, in `acme-desk`. The agent
needs a real model for its typed answer (the stand-in `kindgi dev` starts with
can't produce one). Store your Anthropic key (you're prompted for it; it isn't
echoed) and register the provider:

```sh
npx --yes @kindgi/cli@0.1 secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
npx --yes @kindgi/cli@0.1 providers register --preset=anthropic
```

## 7. Triage a ticket

Run the agent on its own first:

```sh
npx --yes @kindgi/cli@0.1 runs start --agent=acme-desk.triage --input='{"userMessage":"Triage ticket T-101"}'
```

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
gave it. Your reply will read differently: it's the model's.

## 8. Handle tickets

Now the flow, once for each ticket:

```sh
npx --yes @kindgi/cli@0.1 runs start --flow=acme-desk.handle-ticket --input='{"ticketId":"T-100"}'
npx --yes @kindgi/cli@0.1 runs start --flow=acme-desk.handle-ticket --input='{"ticketId":"T-101"}'
```

The first returns `"category": "billing"`, `"priority": "normal"` and a
drafted reply; the second `"category": "access"`, `"priority": "urgent"`.
The journal shows which way each run went. For `T-101`:

```sh
npx --yes @kindgi/cli@0.1 runs journal <run-id>
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

## Next

- [Call it from your app](../../start/existing-app/#starting-runs-from-your-app):
  start the flow from your own code and read its output.
- [Ask before a tool runs](../../guides/approvals/ask-before-a-tool-runs/):
  have a person approve the escalation first.
