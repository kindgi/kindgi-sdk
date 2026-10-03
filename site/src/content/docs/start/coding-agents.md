---
title: Your coding agent
description: The skills kindgi init installs teach Claude Code to write tools, agents, guardrails and flows the way Kindgi expects.
sidebar:
  order: 6
---

You don't have to learn Kindgi's API before your coding agent can use it.
`kindgi init` installs **skills** into the project's `.claude/skills/`:
instructions Claude Code loads when the task calls for them, written for an
agent (what to do, what to check, which mistakes to avoid).

Ask for what you want ("add a tool that looks up a customer by email",
"make the triage agent answer with a typed result", "branch the flow on the
priority") and the agent writes it in your project's language, against the
Kindgi version you have.

## The skills

A pack gets the skills for its language, plus the shared ones.

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

## Keeping them current

The skills are copies, made when you ran `kindgi init`. After upgrading
Kindgi, refresh them:

```sh
kindgi skills sync              # keeps skills you edited; --force replaces them
```

In a Python project, run it as `npx --yes @kindgi/cli@0.1 skills sync`.

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
