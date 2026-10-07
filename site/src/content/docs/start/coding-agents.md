---
title: Your coding agent
description: How your coding agent knows Kindgi, the commands it runs, and what stays with you.
sidebar:
  order: 6
---

You don't have to learn Kindgi before you build with it. Tell your coding
agent what you want, in your own words:

- "Add a tool that looks up a customer by email."
- "Write an agent that answers support tickets with a category, a priority
  and a reply."
- "Connect Claude."
- "Branch the flow on the priority."
- "Why did the last run fail?"

The agent writes the code in your project's TypeScript or Python, runs it
with the Kindgi CLI, reads what happened, and fixes it. This page explains
how it knows to.

## How it knows Kindgi

### Skills, loaded for the task

`kindgi init` copies Kindgi's **skills** into the project, under
`.claude/skills/`. A skill is a page of instructions written for an agent:
the steps, the commands to run, what to check, and the mistakes to avoid.

Each skill opens with a short description of when it applies. Claude Code
reads those descriptions and loads a skill's full text only when your
request matches: asking for a tool loads the tools skill, asking for a
model loads the providers skill. A request that spans several (a tool, an
agent that uses it, a flow around both) loads each one in turn.

| Skill | Loaded when |
|---|---|
| `kindgi-getting-started`, `kindgi-python-getting-started` | Setting up or orienting in a pack |
| `kindgi-authoring-tools`, `kindgi-python-authoring-tools` | Writing a tool: typed input and output, side effects, secrets, HTTP tools |
| `kindgi-authoring-agents`, `kindgi-python-authoring-agents` | Writing an agent: instructions, tools, typed output, budgets |
| `kindgi-authoring-flows`, `kindgi-python-authoring-flows` | Writing a flow: steps, edges, conditions, loops, fanout |
| `kindgi-authoring-guardrails`, `kindgi-python-authoring-guardrails` | Writing a guardrail check |
| `kindgi-authoring-providers` | Connecting a model: Anthropic, Gemini, OpenAI-compatible endpoints |
| `kindgi-authoring-mcp-servers` | Giving the coding agent an MCP server |
| `kindgi-framework-feedback` | Reporting a problem in Kindgi itself |

A pack gets the skills for its language, plus the shared ones.

### Matched to your version

The skills ship with the CLI, so `kindgi init` copies the ones written for
the Kindgi version it installs. The agent writes against the API you have,
not one it half-remembers. After an upgrade, `kindgi dev` tells you the
skills are behind, and `kindgi skills sync` refreshes them (see
[Keeping them current](#keeping-them-current)).

### What else it reads

- **The SDK documents itself.** Every TypeScript export has JSDoc and every
  Python one a docstring, so the agent finds field-level docs right where it
  writes the code.
- **The CLI explains itself.** `kindgi --help`, and `--help` on each
  command, list the commands and their flags.
- **Errors name what's wrong.** A flow step the runtime has no tool for, an
  answer that doesn't match the agent's output schema, a package that's
  only in `devDependencies`: the message says which, and the agent fixes it
  and runs again.
- **These docs, for agents.** [`docs.kindgi.com/llms.txt`](https://docs.kindgi.com/llms.txt)
  indexes this site in plain text, one file per section;
  [`llms-full.txt`](https://docs.kindgi.com/llms-full.txt) is all of it.
  Point an agent there when it needs more than the skills.

## What it runs

The skills tell the agent which `kindgi` commands to run and when, so it
works the way you would: write, run, look, fix.

| Command | What the agent does with it |
|---|---|
| `kindgi init` | Creates a pack, or adds Kindgi to your app |
| `kindgi dev` | Starts Kindgi on your machine, which picks up every save |
| `kindgi runs start` | Tries an agent or a flow with an input, and reads the answer |
| `kindgi runs get`, `runs journal` | Finds out what a run did, step by step, and why it failed |
| `kindgi providers register` | Connects a model, once its key is in your env file |
| `kindgi mcp add` | Gives itself access to a database or another service |
| `kindgi skills sync` | Refreshes its skills after an upgrade |
| `kindgi feedback write` | Records a bug it found in Kindgi itself |
| `kindgi build` | Builds the pack's image for deployment |

It runs the CLI the project pins: `pnpm exec kindgi` in a TypeScript
project, `uv run kindgi` in a Python one.

## What stays with you

- **The names.** You name your pack and its agents. The pack's id prefixes
  every tool, agent and flow (`<pack-id>.<name>`), so pick it once; the skills
  tell the agent to ask you for it rather than guess.
- **The credentials.** You provide them, such as your model provider's API
  key: put it in your env file (`.env` / `.env.local`), or type it into
  `kindgi secrets set`, which asks for it without showing it. The agent never
  invents one or writes one into code. Then it registers the provider.

Logging in to the runtime image's registry is yours too:
`kindgi auth registry` asks for your token the same way
([Install](../install/)).

## Other coding agents

Claude Code loads the skills by itself. They're plain Markdown, so any
coding agent can follow them once it knows where they are:

- A new pack has an `AGENTS.md` that points to them, for agents that read
  `AGENTS.md`.
- In an existing app, `kindgi init` leaves your `AGENTS.md` (or rules file)
  alone. Add a line to it, for example: "Kindgi's instructions are in
  `.claude/skills/`. Before writing Kindgi code, read the skill for the
  task."

## Keeping them current

The skills are copies, made when you ran `kindgi init`. After upgrading
Kindgi, refresh them:

```sh
kindgi skills sync              # keeps skills you edited; --force replaces them
```

In a Python project, run it as `uv run kindgi skills sync`.

`kindgi dev` tells you when the installed skills are behind the CLI's.
`.claude/skills/.kindgi-manifest.json` records what was installed.

## MCP servers for your coding agent

Give the coding agent access to a database or another service through an
MCP server, without writing its secret into the project:

```sh
kindgi mcp presets
kindgi mcp add postgres --secret=MY_DB_URL
```

`add` writes an entry to `.mcp.json` that starts the server with the secret
from your env files. These servers are for your coding agent (Claude Code,
Cursor, VS Code), not for Kindgi's runtime.

## When Kindgi is the problem

If your agent diagnoses a bug in Kindgi rather than in your code, the
`kindgi-framework-feedback` skill has it write a structured note to
`FEEDBACK.md` with `kindgi feedback write`, ready to send to us.
