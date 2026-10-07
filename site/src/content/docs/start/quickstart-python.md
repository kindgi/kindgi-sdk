---
title: "Quickstart: Python"
description: Create a Python pack with tools, an agent, a guardrail and a flow, run it on your machine, and connect a real model.
sidebar:
  order: 4
  label: "Quickstart: Python"
---

The same pack as the [TypeScript quickstart](../quickstart-typescript/), in
Python: two tools, an agent that calls them, a guardrail and a flow.

**Before you start**, set up what the [Install page](../install/) describes:
Docker, Python 3.11 and uv, and access to the runtime image. No Node: the CLI
comes from PyPI. The image is in private preview: request access at contact@kindgi.com,
then log in once with `kindgi auth registry`.

## 1. Create the pack

```sh tutorial=run
uvx --from "kindgi-cli>=0.1,<0.2" kindgi init my-pack --template=python
cd my-pack
uv sync          # a .venv with the kindgi package and the kindgi CLI
uv run pytest    # the template's tests: the tools and the check, called directly
```

:::note[On Kindgi 0.1.0 (fixed in 0.1.1)]
`init` from npm writes no `.gitignore`, so git would track `.env` files
(where model keys go) and `.kindgirc.json` (the dev token). Before your first
commit:

```sh
printf '%s\n' .venv/ __pycache__/ .kindgi/ .kindgirc.json .env '.env.*' >> .gitignore
```
:::

The pack's config is the `[tool.kindgi]` table of its `pyproject.toml`; its
tools, guardrails, agents and flows live in four folders:

```
my-pack/
├── pyproject.toml                    # [tool.kindgi]: the pack's id, version and folders
├── tools/echo.py, tools/greet.py     # @tool
├── guardrails/response_not_empty.py  # @guardrail
├── agents/echo_agent.py              # Agent(...)
├── flows/echo_flow.py                # Flow(...)
├── tests/test_tools.py
└── .claude/skills/                   # skills for your coding agent
```

:::tip[Or ask your coding agent]
The pack already has Kindgi's skills in `.claude/skills/`. Follow the steps
below yourself, or ask your coding agent ("run the pack and try the agent",
"add a tool that looks up an order"): the skills tell it which commands to
run. [How it knows Kindgi](../coding-agents/).
:::

## 2. Run it

```sh tutorial=background ready="Kindgi is up"
uv run kindgi dev
```

`kindgi dev` starts the Kindgi runtime in Docker, indexes the pack with the
pack's own Python (`.venv/bin/python`), runs its tools and checks in a pack
service, and reloads on every save. It writes the API's URL and a token to
`.kindgirc.json`, so the commands below find the runtime by themselves.
Leave it running.

## 3. Run the agent and the flow

In a second terminal, in `my-pack`:

```sh tutorial=run
uv run kindgi runs start --agent=my-pack.echo-agent --input='{"userMessage":"Ada"}'
uv run kindgi runs start --flow=my-pack.echo-flow --input='{"message":"Ada"}'
```

```text tutorial=expect
  "status": "completed",
…
⚠ Answered by "dev-echo", a fallback provider: no other registered provider satisfies agent "my-pack.echo-agent".
…
    "echo": "Ada",
```

Without a model, the agent's answer comes from `dev-echo`, a stand-in that
calls the agent's first tool with `{"message": <your userMessage>}` and
replies with what it returned (the run carries a `fallback-provider`
warning). The flow runs the `echo` tool on its input and returns what the
tool returned. Either way, your Python tool ran: the runtime called it over
HTTP in the pack service.

:::caution[dev-echo checks the wiring, nothing more]
It can't fill in any other tool input, and it can't produce a typed answer
(an agent with an `output` fails with `output-schema-violation`).
Connect a model ([step 5](#5-connect-a-real-model)) before you write an agent
of your own.
:::

## 4. Look at the code

A tool is a typed Python function. Pydantic models are its input and output,
checked on every call:

```python
# tools/echo.py
from datetime import UTC, datetime

from pydantic import BaseModel, Field

from kindgi import tool


class EchoInput(BaseModel):
    message: str = Field(min_length=1, max_length=500)


class Echo(BaseModel):
    echo: str
    echoed_at: str = Field(alias="echoedAt")
    character_count: int = Field(alias="characterCount", ge=0)


@tool(id="my-pack.echo")
def echo(input: EchoInput) -> Echo:
    """Echoes the caller-provided message with a UTC timestamp and character count."""
    return Echo(
        echo=input.message,
        echoedAt=datetime.now(UTC).isoformat(),
        characterCount=len(input.message),
    )
```

An agent is data, and it refers to the tools themselves, not to strings:

```python
# agents/echo_agent.py
from kindgi import Agent

from ..guardrails.response_not_empty import response_not_empty
from ..tools.echo import echo
from ..tools.greet import greet

echo_agent = Agent(
    id="my-pack.echo-agent",
    version="0.1.0",
    name="Echo Agent",
    description="Uses the pack's echo and greet tools; the response-not-empty guardrail guards the output.",
    instructions=(
        "For each user message: if the user sends a name, greet them with the greet tool. "
        "Otherwise echo their message with the echo tool. Quote the tool result verbatim."
    ),
    capabilities=[{"needs": [{"feature": "tool-use"}]}],
    tools=[echo, greet],
    guardrails=[response_not_empty],
    conversation_policy={"historyLimit": 10},
    budget={"maxSteps": 4, "maxCostUsd": 0.1, "maxWallMs": 60_000},
)
```

`uv run python -m kindgi.pack index --pack-dir .` prints what Kindgi sees.
A file with an error is reported with its path, and the rest of the pack
keeps serving.

## 5. Connect a real model

Store an Anthropic key as a secret (you're prompted for it; it isn't
echoed), then register the provider:

```sh
uv run kindgi secrets set ANTHROPIC_API_KEY --env=local --scope=tenant
uv run kindgi providers register --preset=anthropic
```

It takes over from `dev-echo` at the next turn. Gemini on Vertex AI has a
preset too; any OpenAI-compatible endpoint registers from a short spec file.

The registration is in this project's dev database. To have `kindgi dev`
register the model on every boot, in each worktree and after `--reset`,
declare it in `pyproject.toml`: [Declare them in your pack's config](../../guides/models/#declare-them-in-your-packs-config).

## Next

- [Add Kindgi to an existing Python app](../existing-app/#a-python-app):
  your app's own modules as tools.
- [Build a support desk](../../tutorials/support-desk-python/) in Python.
- [Guides](../../guides/): one task at a time.
- [Concepts](../../concepts/): packs, runs and the journal, security.
- [The Python SDK reference](../../reference/python/).
- [Set up your coding agent](../coding-agents/): it already has Kindgi's
  skills.
