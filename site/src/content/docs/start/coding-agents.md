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
`.claude/skills/` and `.agents/skills/` (the same copy in each), for a
TypeScript, Python, Java or Scala project. Each coding agent looks in one of
the two ([Other coding agents](#other-coding-agents)). A skill
is a page of instructions written for an agent:
the steps, the commands to run, what to check, and the mistakes to avoid.

Each skill opens with a short description of when it applies. Claude Code
reads those descriptions and loads a skill's full text only when your
request matches: asking for a tool loads the tools skill, asking for a
model loads the providers skill. A request that spans several (a tool, an
agent that uses it, a flow around both) loads each one in turn.

| Skill | Loaded when |
|---|---|
| `kindgi-getting-started`, `kindgi-python-getting-started`, `kindgi-java-getting-started`, `kindgi-scala-getting-started` | Setting up or orienting in a pack, or upgrading a self-hosted deployment |
| `kindgi-authoring-tools`, `kindgi-python-authoring-tools`, `kindgi-java-authoring-tools`, `kindgi-scala-authoring-tools` | Writing a tool: typed input and output, side effects, secrets, HTTP tools |
| `kindgi-authoring-agents`, `kindgi-python-authoring-agents`, `kindgi-java-authoring-agents`, `kindgi-scala-authoring-agents` | Writing an agent: instructions, tools, typed output, budgets |
| `kindgi-authoring-flows`, `kindgi-python-authoring-flows`, `kindgi-java-authoring-flows`, `kindgi-scala-authoring-flows` | Writing a flow: steps, edges, conditions, loops, fanout |
| `kindgi-authoring-guardrails`, `kindgi-python-authoring-guardrails`, `kindgi-java-authoring-guardrails`, `kindgi-scala-authoring-guardrails` | Writing a guardrail check |
| `kindgi-authoring-providers` | Connecting a model: Anthropic, Gemini, OpenAI-compatible endpoints |
| `kindgi-authoring-mcp-servers` | Giving the coding agent an MCP server |
| `kindgi-framework-feedback` | Reporting a problem in Kindgi itself, and sending it to us once you've said yes |
| `kindgi-using` | Guiding you in using what was built: the CLI's answer and the console page beside it |

Your coding agent also guides you in using what it built. Ask it to show
you around Kindgi's console or to find something (the answers an agent
gave, who has access, what waits for a decision), and with
`kindgi-using` it answers with the CLI's answer and the console page side
by side. Deciding approvals, erasing, people, keys and making a version
live stay yours: it gives you the page and the clicks.

A pack gets the skills for its language, plus the shared ones.

### Matched to your version

The skills ship with the CLI, so `kindgi init` copies the ones written for
the Kindgi version it installs. The agent writes against the API you have,
not one it half-remembers. After an upgrade, `kindgi dev` refreshes them as
it starts, and `kindgi skills sync` refreshes them any time (see
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
- **These docs, for agents.** Every page has a Markdown version: replace
  the slash at the end of its URL with `.md`. Under each page's title,
  **Copy as Markdown** copies it, to paste into a chat with your agent, and
  **View as Markdown** opens it.
  [`docs.kindgi.com/llms.txt`](https://docs.kindgi.com/llms.txt), linked at
  the bottom of every page, lists every page's Markdown version by section,
  and links one file per section.
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
| `kindgi skills sync` | Refreshes its skills any time |
| `kindgi feedback write` | Records a bug it found in Kindgi itself |
| `kindgi feedback submit` | Shows you that record as it would be sent, and sends it only after you say yes |
| `kindgi feedback status` | Tells you what became of what you sent: known, fixed, or won't be fixed |
| `kindgi build` | Builds the pack's image for deployment |

It runs the CLI the project pins: `pnpm exec kindgi` in a TypeScript
project, `uv run kindgi` in a Python one.

There's one `kindgi dev` per pack. When yours is already running, a
`kindgi dev` the agent starts exits with code 3 and says where yours is:
its process, the console and the API. Nothing of yours is touched: the
agent uses yours (with `--json`, it gets the same as
`{ "running": { … } }`).

## What stays with you

- **The names.** You name your pack and its agents. The pack's id prefixes
  every tool, agent and flow (`<pack-id>.<name>`), so pick it once; the skills
  tell the agent to ask you for it rather than guess.
- **The credentials.** You provide them, such as your model provider's API
  key: type it into `kindgi secrets set`, which asks for it without showing it
  and keeps it in Kindgi's own `.kindgi/secrets.env`. The agent never invents
  one or writes one into code. Then it registers the provider.
- **What the code can reach.** `kindgi dev` runs the code the agent writes
  sandboxed: it can't read your keys, your other projects or the Docker
  socket, though it keeps the network and the app's own files
  ([Keep your tools' code away from your keys](../../guides/secrets/dev-sandbox/)).

Logging in to the runtime image's registry is yours too:
`kindgi auth registry` asks for your license key the same way
([Install](../install/)).

## Keep it out of your keys

### Claude Code

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
paths. A repository rooted at your home folder (your dotfiles, say) is left
alone: its `.claude/settings.json` is Claude Code's settings for every
project, so `init` only says what you could add there. An agent started in the pack's folder uses the pack's own file. One
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

### Codex

Codex has no ignore file, and nothing `kindgi init` writes binds it. Its
sandbox can refuse to read a path, with a permission profile in the
project's `.codex/config.toml`
([configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
With it, neither Codex's shell commands nor a program they run (`node -e …`,
a copy, a link) can read the files the profile names. Tested with Codex
0.162.1:

```toml
default_permissions = "kindgi"

[permissions.kindgi]
extends = ":workspace"

[permissions.kindgi.filesystem.":workspace_roots"]
".git" = "read"
".codex" = "read"
".agents" = "read"
".aws" = "read"
"**/.env*" = "deny"
".kindgi/secrets.env" = "deny"
".kindgi/dev/runtime.env" = "deny"
"kindgi.env" = "deny"
"pack.env" = "deny"
```

The four `"read"` lines keep read-only the folders that Codex's default
sandbox protects. Without them, Codex could edit `.codex/config.toml` and
drop these rules for its next session, or add a Git hook, which runs outside
its sandbox.

Codex loads the profile only once you trust the project, in your own Codex
config (`~/.codex/config.toml`):

```toml
[projects."/path/to/your/project"]
trust_level = "trusted"
```

A `-c` trust override on the command line doesn't count. `codex exec`
doesn't ask: in a project you haven't trusted, it runs without the profile,
and can read the files. In CI, give it the profile on the command line
instead, which holds whether the project is trusted or not:

```sh
codex exec \
  -c 'default_permissions="kindgi"' \
  -c 'permissions.kindgi={extends=":workspace",filesystem={":workspace_roots"={".git"="read",".codex"="read",".agents"="read",".aws"="read","**/.env*"="deny",".kindgi/secrets.env"="deny",".kindgi/dev/runtime.env"="deny","kindgi.env"="deny","pack.env"="deny"}}}' \
  "<your prompt>"
```

The reference says not to combine `default_permissions` with
`sandbox_mode`, so for this project the profile takes the place of the
sandbox mode you'd otherwise set. Like Codex's default sandbox, the profile
turns the network off.

### Gemini CLI

Gemini CLI's file search skips what `.gitignore` lists
(`context.fileFiltering.respectGitIgnore`, on by default), and `kindgi init`
adds `.kindgi/` and `.env.local` there. For the other files, add a
`.geminiignore` at the project's root (gitignore syntax); `kindgi init` adds
them to one the project already has:

```text
.env*
.kindgi/secrets.env
.kindgi/dev/runtime.env
kindgi.env
pack.env
```

Its docs name the tools that respect `.geminiignore` only by example (`@`
file sharing), so don't count on it for a command its shell runs
([.geminiignore](https://geminicli.com/docs/cli/gemini-ignore/)).

### What these settings don't cover

These settings keep the agent's own tools and commands out of your keys. The
code it writes still runs in your app and in `kindgi dev`, with your access.
Under `kindgi dev`, your pack's tools never get a secret stored with
`kindgi secrets set`, nor a model provider's key, in their environment. Your
app's routes do see what its own env files hold. Read what the agent writes.

## Other coding agents

The skills are plain Markdown, in the two folders coding agents look in.
Where each agent looks, from its own documentation:

| Agent | Finds Kindgi's skills in | Its docs |
|---|---|---|
| Claude Code | `.claude/skills/` | [Skills](https://code.claude.com/docs/en/skills) |
| Codex | `.agents/skills/`, in the folder it starts in and each one above it up to the repository's root | [Skills](https://learn.chatgpt.com/docs/build-skills) |
| Gemini CLI | `.agents/skills/`, ahead of its own `.gemini/skills/` | [Agent Skills](https://geminicli.com/docs/cli/skills/) |
| Cursor | `.agents/skills/`, and `.claude/skills/` for compatibility | [Skills](https://cursor.com/docs/skills) |
| VS Code (GitHub Copilot) | `.agents/skills/` and `.claude/skills/` | [Agent skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) |

VS Code's Skills page lists a skill once for each folder it's in, so you'll
see each Kindgi skill twice there; the two copies are the same.

- A new pack has an `AGENTS.md` that points to them, for agents that read
  `AGENTS.md`. Gemini CLI reads `GEMINI.md` instead, unless its
  `context.fileName` setting names `AGENTS.md`
  ([its settings](https://geminicli.com/docs/reference/configuration/)),
  in `.gemini/settings.json`:

  ```json
  { "context": { "fileName": ["AGENTS.md", "GEMINI.md"] } }
  ```

  The getting-started skill holds the same instructions, and Gemini CLI
  finds it in `.agents/skills/` either way.
- In an existing app, `kindgi init` leaves your `AGENTS.md` (or rules file)
  alone. Add a line to it, for example: "Kindgi's instructions are in
  `.agents/skills/` (the same as `.claude/skills/`). Before writing Kindgi
  code, read the skill for the task."

### When its sandbox blocks a command

Two commands are always yours to run, in your own terminal, since they ask
for a secret: `kindgi secrets set` and `kindgi auth registry`. A coding agent
in a sandbox may be blocked from others: starting `kindgi dev`
(`spawn EPERM`), reaching Docker's socket, or connecting to `localhost`. Codex's
default sandbox, for one, turns the network off and keeps `.agents/`
read-only ([its docs](https://learn.chatgpt.com/docs/agent-approvals-security)),
so `kindgi skills sync` is yours to run there. The
[profile above](#codex) keeps `.agents/` read-only too.

The skills and a new pack's `AGENTS.md` tell the agent not to work around a
block: no turning its sandbox off, no starting the command in the
background. It gives you the exact command, the folder to run it in and what
you'll see, and waits until you say it's running. Once your `kindgi dev`
runs, the agent's `kindgi dev` exits with code 3 and says where yours is, and
the agent uses yours.

## Keeping them current

The skills are copies, made when you ran `kindgi init`: one in
`.claude/skills/`, one in `.agents/skills/`. After you upgrade Kindgi, the
next `kindgi dev` refreshes both as it starts, and says so:

```text
  ✓ Framework skills: 2 updated, 1 added.
    · 1 you edited is kept: `pnpm exec kindgi skills sync --force` replaces it.
```

It keeps skills you edited, as `kindgi skills sync` does. A skill you
deleted stays deleted, and so does a skills folder you deleted: it says
which are behind, and the command that brings them back. Without the
manifest (below), it changes nothing and only says the skills are behind.

To refresh them yourself, at any time:

```sh
pnpm exec kindgi skills sync
```

A skill is a folder: its `SKILL.md`, which the agent loads, and the files
beside it, which it reads only for its case. It keeps skills you edited, in
either folder: a change to any of a skill's files keeps the whole skill as
it is. `--force` replaces those too. A skill or a file of one you deleted
comes back, and a file the skill no longer has is removed unless you
edited it. A file you added to a skill's folder is yours: it's never
changed or removed. In a Python project, run it as
`uv run kindgi skills sync`. If the project has a `.prettierignore`, it adds
Kindgi's skills in both folders to it, so your formatter leaves the copies
alone.

Which release each copy came from, in both folders, and each of its files,
is recorded in `.claude/skills/.kindgi-manifest.json`. Keep it, even if you don't use
Claude Code: without it, `kindgi skills sync` can't tell a copy that's
behind from one you edited, so it keeps every copy that's behind (`--force`
replaces them), and `kindgi dev` doesn't refresh them.

It says what it did in each folder, then prints the same as JSON (with
`--json`, the JSON alone):

```text
Synced ./.claude/skills/ and ./.agents/skills/

.claude/skills/
  = kindgi-authoring-agents @0.4.6
…
  0 added, 0 updated, 9 unchanged, 0 skipped-modified, 0 local-only

.agents/skills/
  = kindgi-authoring-agents @0.4.6
…
  0 added, 0 updated, 9 unchanged, 0 skipped-modified, 0 local-only

SDK release: …
{
  "targetDir": ".",
  "packLanguage": "node",
  "outcomes": [
    {
      "name": "kindgi-authoring-agents",
      "folder": ".claude/skills",
      "status": "unchanged",
…
  "dryRun": false,
  "force": false
}
```

`kindgi dev` refreshes the installed skills when they're behind the CLI's,
in either folder, and says what it left behind. `.claude/skills/.kindgi-manifest.json`
records what was installed in both.

## MCP servers for your coding agent

Give the coding agent access to a database or another service through an
MCP server, without writing its secret into the project:

```sh
pnpm exec kindgi mcp presets
pnpm exec kindgi secrets set MY_DB_URL --env=local --scope=tenant
pnpm exec kindgi mcp add postgres --secret=MY_DB_URL
```

- `mcp presets` lists the servers Kindgi has a preset for.
- `secrets set` stores the server's connection, for `postgres` a
  `postgresql://` URL, in Kindgi's own `.kindgi/secrets.env`. It asks for
  the value without showing it, and needs `kindgi dev` running.
- `add` writes an entry to `.mcp.json` that starts the server. `--secret`
  names the secret that holds the server's connection: the server gets its
  value when it starts, and `.mcp.json` never holds it.

They print:

```text
{
  "root": "…",
  "presets": [
    {
      "kind": "postgres",
      "runtime": "docker",
      "package": "crystaldba/postgres-mcp",
…
  Set MY_DB_URL at tenant in local.
…
  Added "my_db" (preset postgres) to .mcp.json.
  Restart your MCP client (Claude Code, Cursor, ...) to activate.
```

These servers are for your coding agent (Claude Code, Cursor, VS Code), not
for Kindgi's runtime.

## When Kindgi is the problem

If your agent diagnoses a bug in Kindgi rather than in your code, the
`kindgi-framework-feedback` skill has it write a structured note to
`FEEDBACK.md` with `kindgi feedback write`. When you want it sent to us,
it previews the report with `kindgi feedback submit --preview` and shows it
to you: exactly what's sent, after keys, env values and paths are redacted.
It sends the report only after you say yes. Later, it tells you what became
of it. [Send us feedback](../send-feedback/) says what's sent, what we keep
and for how long, and how to take a report back.

## Next

- [Set up Kindgi with your coding agent](../agent/): the steps it follows,
  from nothing to a first agent that answers.
- [Quickstart: TypeScript](../quickstart-typescript/), or the
  [Python](../quickstart-python/) one: the same steps, by hand.
