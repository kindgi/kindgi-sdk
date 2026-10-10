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

## This pack: a WooCommerce store

README.md explains the whole design; keep it true when you change the pack.

- **Approvals live in each agent's `conversationPolicy.hitl.tools`.**
  `default: 'always_ask'` stays: a new tool waits for a person until a
  person decides otherwise. Don't add a `never_ask` override for a tool
  that changes the store or moves money, unless the person you work for
  asks for exactly that.
- **The refund limit is two tools.** Approval rules key on the tool, not
  its arguments. `woo.refund` (no approval) is capped by its input schema
  and its handler (`REFUND_LIMIT`, counting earlier refunds); larger
  refunds go through `woo.refund-large` (always approved). Keep both caps
  when you change one.
- **Order events are untrusted.** `woo.check-order-event` runs before
  any model sees an event and keeps typed fields only; the agent that
  reads events (`order-reviewer`) has read-only tools. Keep it that way:
  an agent's guardrails check its answer after the turn, so they can't
  stop a tool call.
- **The store's password is a secret** (`WOO_APP_PASSWORD`, set with
  `kindgi secrets set`): never write it in a file, a test or the chat.

## For Claude Code sessions

When you diagnose a framework bug (something in Kindgi itself, not in
this pack's code), append an entry to `FEEDBACK.md` at the pack root
via `kindgi feedback write` — see
`.claude/skills/kindgi-framework-feedback/SKILL.md`. Mark items fixed
by adding a `> **Fixed:** <note>` line right after their header; the
file is a plain markdown list you edit directly.
