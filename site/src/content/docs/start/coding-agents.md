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
`.claude/skills/`, for a TypeScript, Python, Java or Scala project. A skill
is a page of instructions written for an agent:
the steps, the commands to run, what to check, and the mistakes to avoid.

Each skill opens with a short description of when it applies. Claude Code
reads those descriptions and loads a skill's full text only when your
request matches: asking for a tool loads the tools skill, asking for a
model loads the providers skill. A request that spans several (a tool, an
agent that uses it, a flow around both) loads each one in turn.

| Skill | Loaded when |
|---|---|
| `kindgi-getting-started`, `kindgi-python-getting-started`, `kindgi-java-getting-started`, `kindgi-scala-getting-started` | Setting up or orienting in a pack |
| `kindgi-authoring-tools`, `kindgi-python-authoring-tools`, `kindgi-java-authoring-tools`, `kindgi-scala-authoring-tools` | Writing a tool: typed input and output, side effects, secrets, HTTP tools |
| `kindgi-authoring-agents`, `kindgi-python-authoring-agents`, `kindgi-java-authoring-agents`, `kindgi-scala-authoring-agents` | Writing an agent: instructions, tools, typed output, budgets |
| `kindgi-authoring-flows`, `kindgi-python-authoring-flows`, `kindgi-java-authoring-flows`, `kindgi-scala-authoring-flows` | Writing a flow: steps, edges, conditions, loops, fanout |
| `kindgi-authoring-guardrails`, `kindgi-python-authoring-guardrails`, `kindgi-java-authoring-guardrails`, `kindgi-scala-authoring-guardrails` | Writing a guardrail check |
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
  key: type it into `kindgi secrets set`, which asks for it without showing it
  and keeps it in Kindgi's own `.kindgi/secrets.env`. The agent never invents
  one or writes one into code. Then it registers the provider.

Logging in to the runtime image's registry is yours too:
`kindgi auth registry` asks for your token the same way
([Install](../install/)).

## Keep it out of your keys

`kindgi init` adds deny rules to your project's `.claude/settings.json`, so
Claude Code's file tools never read the files that hold keys and tokens:

```json
{
  "permissions": {
    "deny": [
      "Read(./.env*)",
      "Read(./.kindgi/secrets.env)",
      "Read(./.kindgi/dev/runtime.env)",
      "Read(./kindgi.env)",
      "Read(./pack.env)"
    ]
  }
}
```

It merges them into a settings file you already have, and leaves one it can't
read as JSON alone, saying what to add. A project with a `.cursorignore`,
`.geminiignore` or `.aiderignore` gets the same files added to it.

**In a monorepo,** mind where the agent starts. Claude Code reads
`.claude/settings.json` from the folder a session starts in, and a `./` rule
is relative to that folder. So when your pack sits below its repository's
root, `kindgi init` also adds the rules, under the pack's path, to the root's
`.claude/settings.json` (creating it if there's none), and says so:

```text
✓ /…/acme/.claude/settings.json: created with 5 deny rules for apps/agent/, so an agent started at the repo root can't read this pack's keys
```

The root's file then holds `"Read(./apps/agent/.env*)"`,
`"Read(./apps/agent/.kindgi/secrets.env)"` and so on, merged the same way, and
a `.cursorignore`, `.geminiignore` or `.aiderignore` at the root gets the same
paths. An agent started in the pack's folder uses the pack's own file. One
started in another folder of the repository loads neither. The pack's files
are outside its folder, so Claude Code asks you before it reads them, unless
reads are already allowed (in your settings, or with `--allowedTools`): then it
reads them. Start the agent in the pack's folder or at the repository's root.
A bare `./.env*` matches at any depth below the session's folder; a rule with
a folder in it, such as `./.kindgi/secrets.env`, matches only there.

The rules stop the agent's file tools, and a plain `cat .env.local` too. A
program its shell runs (`node -e …`, a script) can still read the files. To
close that, turn on Claude Code's
[sandbox](https://code.claude.com/docs/en/sandboxing) with the same files.
Tested with Claude Code 2.1.288:

```json
{
  "permissions": {
    "deny": [
      "Read(./.env*)",
      "Read(./.kindgi/secrets.env)",
      "Read(./.kindgi/dev/runtime.env)",
      "Read(./kindgi.env)",
      "Read(./pack.env)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "denyRead": [
        "./.env*",
        "./.kindgi/secrets.env",
        "./.kindgi/dev/runtime.env",
        "./kindgi.env",
        "./pack.env"
      ],
      "allowWrite": ["~/.npm"]
    },
    "network": { "allowedDomains": ["registry.npmjs.org"], "allowLocalBinding": true }
  }
}
```

- **`allowLocalBinding`** lets the agent's `kindgi` commands reach
  `kindgi dev`, and its `curl` reach your app, on `localhost`. Without it,
  every `kindgi runs start` fails.
- **The npm registry and `~/.npm`** let it install packages.
- **`.kindgirc.json` isn't on either list:** it holds the dev token the
  agent's own `kindgi` commands read to find `kindgi dev`. With the sandbox
  on, a `Read` deny rule binds the agent's shell commands too, so denying it
  would break them.
- **In a monorepo,** put the sandbox in the root's settings, with the same
  paths under the pack's folder in both lists (`"./apps/agent/.env*"`, …).
- **Some things then run in a terminal of your own:** `kindgi dev`, your
  app's dev server, and anything that needs Docker, such as `kindgi build`.
  `kindgi doctor` works, and says which checks it skipped because it couldn't
  read a file.

These settings keep the agent's own tools and commands out of your keys. The
code it writes still runs in your app and in `kindgi dev`, with your access.
Under `kindgi dev`, your pack's tools never get a secret stored with
`kindgi secrets set`, nor a model provider's key, in their environment. Your
app's routes do see what its own env files hold. Read what the agent writes.

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
