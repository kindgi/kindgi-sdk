# AGENTS.md

This directory is a Kindgi pack written in Scala (`com.kindgi %% kindgi-pack-scala`,
package `com.kindgi.pack.scaladsl`). Tools (`Tool[Input, Output](id)`) and
guardrail checks (`Guardrail[Config](id)`) are `val`s of an object named like
its file, under `src/main/scala/**/tools/` and `…/guardrails/`; agents
(`Agent(id)`) and flows (`Flow(id)`) are data, under `…/agents/` and
`…/flows/`. A tool's input and output schemas come from its case classes:
`Option` is optional, a parameter's default is the schema's default, Jakarta
Validation constraints become their keywords (in Scala 3, name their arguments:
`@Min(value = 0)`). A tool defined as a `def` or a `lazy val` isn't indexed:
make it a `val`. The config is `kindgi.config.json`.

- `./kindgiw dev` boots Kindgi locally, compiles this pack through sbt's server
  and runs it with its JDK (17 or later), recompiling on every save.
- `sbt test` runs the tests; `tool.call(input, ToolContext.forTest())` calls a
  handler directly.
- `java -cp "$(sbt -batch -error 'export Runtime/fullClasspath')" com.kindgi.pack.Main index --pack-dir .`
  shows what Kindgi sees.
- Agents answer through a model provider. `kindgi dev` gives a new pack
  `dev-echo`, a fallback that isn't a model: it calls the first tool and
  replies "Tool responded: …" after a warning line, while no other provider
  fits. For a real model, put one LLM provider's key in `.env`
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY` or
  `OPENROUTER_API_KEY`) and add a `providers` list with its preset
  (`[{"preset": "anthropic"}]`, or `"openai"`, `"gemini-api"`, `"groq"`,
  `"openrouter"`) to `kindgi.config.json`: `kindgi dev` then registers it on
  every boot, in every worktree.
  How much a model thinks (runtime 0.3.0 or later): `thinking` in the
  agent's `modelSettings` block, else the model's registered
  `thinking.default`, else its vendor's own.
- Each git worktree runs its own `kindgi dev`, with its own dev tenant,
  user and token, and its own database in the bundled Postgres. When port
  4000 is taken (another worktree's, say), it takes the next free one,
  prints it and records it in `.kindgirc.json`. The getting-started skill
  has the details.

## Skills

`.claude/skills/` and `.agents/skills/` hold the same Kindgi skills for
Scala packs: getting started, tools, guardrails, agents and flows in Scala
(`kindgi-scala-*`), model providers, MCP servers, framework feedback, and
guiding the person in using what you built (`kindgi-using`). Claude Code
loads `.claude/skills/` on its own; Codex and Gemini CLI look in
`.agents/skills/`; any other coding agent can read either.
After an upgrade, `./kindgiw dev` refreshes both as it starts;
`./kindgiw skills sync` refreshes them any time.

When you diagnose a framework bug (something in Kindgi itself, not in this
pack's code), append an entry to `FEEDBACK.md` at the pack root with
`./kindgiw feedback write`.
Send entries to Kindgi only after the person has seen the preview and said
yes: `./kindgiw feedback submit --preview`, then `--yes=<its digest>`.

When the person asks how to use what you built (where something is in
Kindgi's console, what an agent did, what it cost, who has access), answer
from `./kindgiw`'s read-only commands and give the console link beside it:
see the `kindgi-using` skill. Deciding approvals, erasing, adding people
and rating answers stay with the person.

## Commands for the person's own terminal

Two commands are always the person's to run, in their own terminal, since
they ask for a secret: `./kindgiw secrets set` and
`./kindgiw auth registry`. Others need what a coding agent's sandbox often
blocks: `./kindgiw dev` and any dev server (they keep running), and
`./kindgiw build` or anything else that needs Docker. When your sandbox
blocks a command (a process it can't start, `spawn EPERM`; Docker's socket
denied; `localhost` refused; a folder it keeps read-only, as Codex's keeps
`.agents/`, which `./kindgiw skills sync` writes), don't work around it:
don't turn your sandbox off, and don't start the command in the background.
Give the person the exact command, the folder to run it in and what they'll
see, then wait for them. Once they say `./kindgiw dev` is running, starting
it yourself exits 3 and says where theirs runs: use that one.

A tool's own `EPERM` while it runs under `./kindgiw dev` is something else:
Kindgi's dev sandbox, which the tools skill covers. Never turn that one off
either.
