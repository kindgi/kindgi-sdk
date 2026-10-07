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
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY` or
`OPENROUTER_API_KEY`) and declare its preset (`{ preset: 'anthropic' }`,
`'openai'`, `'gemini-api'`, `'groq'` or `'openrouter'`) in
`kindgi.config.ts`'s `providers`: `kindgi dev` then registers it on every
boot, in every worktree. Other providers and per-agent model choice:
`.claude/skills/kindgi-authoring-providers/SKILL.md`.

## For Claude Code sessions

When you diagnose a framework bug (something in Kindgi itself, not in
this pack's code), append an entry to `FEEDBACK.md` at the pack root
via `kindgi feedback write` — see
`.claude/skills/kindgi-framework-feedback/SKILL.md`. Mark items fixed
by adding a `> **Fixed:** <note>` line right after their header; the
file is a plain markdown list you edit directly.
