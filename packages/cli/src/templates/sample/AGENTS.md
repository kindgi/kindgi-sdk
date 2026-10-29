# AGENTS.md

This directory is a Kindgi pack. Author primitives via
`@kindgi/sdk` — `defineTool`, `defineAgent`, `defineCheck`,
`defineFlow`. Every export ships with JSDoc; hover them for
field-level docs. Iterate with `kindgi dev`; `kindgi --help` lists
the full CLI.

Agents answer through a model provider. `kindgi dev` gives a new pack
`dev-echo`, a fallback that isn't a model: it calls the first tool and
replies "Tool responded: …" after a warning line, while no other provider
fits. For a real model, put one LLM provider's key in `.env`
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`
or `OPENROUTER_API_KEY`) and declare its preset
(`{ preset: 'anthropic' }`, `'openai'`, `'gemini-api'`, `'groq'` or
`'openrouter'`) in `kindgi.config.ts`'s `providers`: `kindgi dev` then
registers it on every boot, in every worktree. Other providers and
per-agent model choice: the `kindgi-authoring-providers` skill.
How much a model thinks (runtime 0.3.0 or later): `thinking` in the
agent's `modelSettings` block, else the model's registered
`thinking.default`, else its vendor's own.

Each git worktree runs its own `kindgi dev`, with its own dev tenant,
user and token, and its own database in the bundled Postgres. When port
4000 is taken (another worktree's, say), it takes the next free one,
prints it and records it in `.kindgirc.json`. The getting-started skill
has the details.

## Skills

`.claude/skills/` and `.agents/skills/` hold the same Kindgi skills: getting
started, tools, guardrails, agents and flows, model providers, MCP servers,
framework feedback, and guiding the person in using what you built
(`kindgi-using`). Claude Code loads `.claude/skills/` on its own; Codex and
Gemini CLI look in `.agents/skills/`; any other coding agent can read
either. After an upgrade, `kindgi dev` refreshes both as it
starts; `kindgi skills sync` refreshes them any time.

When you diagnose a framework bug (something in Kindgi itself, not in this
pack's code), append an entry to `FEEDBACK.md` at the pack root via
`kindgi feedback write` — see the `kindgi-framework-feedback` skill. Mark
items fixed by adding a `> **Fixed:** <note>` line right after their
header; the file is a plain markdown list you edit directly.
Send entries to Kindgi only after the person has seen the preview and said
yes: `kindgi feedback submit --preview`, then `--yes=<its digest>`.

When the person asks how to use what you built (where something is in
Kindgi's console, what an agent did, what it cost, who has access), answer
from `kindgi`'s read-only commands and give the console link beside it —
see the `kindgi-using` skill. Deciding approvals, erasing, adding people
and rating answers stay with the person.

## Commands for the person's own terminal

Two commands are always the person's to run, in their own terminal, since
they ask for a secret: `kindgi secrets set` and `kindgi auth registry`.
Others need what a coding agent's sandbox often blocks: `kindgi dev` and any
dev server (they keep running), and `kindgi build` or anything else that
needs Docker. When your sandbox blocks a command (a process it can't start,
`spawn EPERM`; Docker's socket denied; `localhost` refused; a folder it
keeps read-only, as Codex's keeps `.agents/`, which `kindgi skills sync`
writes), don't work around it: don't turn your sandbox off, and don't start
the command in the background. Give the person the exact command, the folder
to run it in and what they'll see, then wait for them. Once they say
`kindgi dev` is running, starting it yourself exits 3 and says where theirs
runs: use that one.

A tool's own `EPERM` while it runs under `kindgi dev` is something else:
Kindgi's dev sandbox, which the tools skill covers. Never turn that one off
either.
