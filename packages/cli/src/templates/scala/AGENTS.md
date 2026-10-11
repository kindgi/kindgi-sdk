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

When you diagnose a framework bug (something in Kindgi itself, not in this
pack's code), append an entry to `FEEDBACK.md` at the pack root with
`./kindgiw feedback write`.
