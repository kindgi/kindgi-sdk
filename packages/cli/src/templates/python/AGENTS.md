# AGENTS.md

This directory is a Kindgi pack written in Python (the `kindgi` package).
Tools are `@tool` functions, guardrail checks `@guardrail` functions; agents
(`Agent`) and flows (`Flow`) are data. Each lives at module level in a file
under `tools/`, `guardrails/`, `agents/` or `flows/`; a helper module there
starts with `_`. The config is `[tool.kindgi]` in `pyproject.toml`.

- `kindgi dev` boots Kindgi locally and runs this pack's code with its own
  `.venv`, reloading on every save.
- `uv run pytest` runs the tests; a `Tool` or `Guardrail` is still callable.
- `uv run python -m kindgi.pack index --pack-dir .` shows what Kindgi sees.
- Agents answer through a model provider. `kindgi dev` gives a new pack
  `dev-echo`, a fallback that isn't a model: it calls the first tool and
  replies "Tool responded: …" after a warning line, while no other provider
  fits. For a real model, put one LLM provider's key in `.env`
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`) and add a
  `[[tool.kindgi.providers]]` table with its preset (`preset = "anthropic"`,
  `"openai"` or `"openrouter"`) to `pyproject.toml`: `kindgi dev` then registers it
  on every boot, in every worktree. Other providers and per-agent model
  choice: `.claude/skills/kindgi-authoring-providers/SKILL.md`.

## Skills

`.claude/skills/` holds Kindgi's skills for Python packs: getting started,
tools, guardrails and agents in Python (`kindgi-python-*`), model providers,
MCP servers, framework feedback. Claude Code loads them on its own; other
coding agents can read them. `kindgi skills sync` refreshes them.

When you diagnose a framework bug (something in Kindgi itself, not in this
pack's code), append an entry to `FEEDBACK.md` at the pack root via
`kindgi feedback write` — see
`.claude/skills/kindgi-framework-feedback/SKILL.md`.
