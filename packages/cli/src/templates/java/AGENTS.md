# AGENTS.md

This directory is a Kindgi pack written in Java (`com.kindgi:kindgi-pack`).
Tools (`Tool.define(...)`) and guardrail checks (`Guardrail.define(...)`) are
`public static final` fields of classes under `src/main/java/**/tools/` and
`…/guardrails/`; agents (`Agent.define(...)`) and flows (`Flow.define(...)`) are
data, under `…/agents/` and `…/flows/`. A tool's input and output schemas come
from its record types (Jakarta Validation constraints become their keywords). A
helper class there is package-private, or a record, an enum or an interface.
The config is `kindgi.config.json`.

- `kindgi dev` boots Kindgi locally, compiles this pack with Maven and runs it
  with its JDK (17 or later), recompiling on every save.
- `./mvnw test` runs the tests; `Tool.call(input, ToolContext.forTest())` calls
  a handler directly.
- `java -cp "target/classes:$(cat target/classpath.txt)" com.kindgi.pack.Main index --pack-dir .`
  shows what Kindgi sees, after
  `./mvnw -q compile dependency:build-classpath -Dmdep.outputFile=target/classpath.txt`.
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
`kindgi feedback write`.
