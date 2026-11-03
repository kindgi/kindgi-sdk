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

Each git worktree runs its own `kindgi dev`, with its own dev workspace,
user and token, and its own database in the bundled Postgres. When port
4000 is taken (another worktree's, say), it takes the next free one,
prints it and records it in `.kindgirc.json`. The getting-started skill
has the details.

## This pack: a WooCommerce store

README.md explains the whole design; keep it true when you change the pack.

- **Approvals live in each agent's `conversationPolicy.hitl.tools`.**
  `default: 'always_ask'` stays: a new tool waits for a person until a
  person decides otherwise. Don't add a `never_ask` override for a tool
  that changes the store or moves money, unless the person you work for
  asks for exactly that.
- **The refund limit is two tools.** Approval rules key on the tool, not
  its arguments. `woo.refund` (no approval when a person starts the turn)
  is capped by its input schema and its handler (`REFUND_LIMIT`, counting
  earlier refunds); larger refunds go through `woo.refund-large` (always
  approved). Keep both caps when you change one.
- **Tools that move money or change the store declare
  `needsApprovalWhenUnattended: true`** (`woo.refund`, `woo.refund-large`,
  `woo.set-price`, `woo.publish-product`): in a run no person started, each
  call waits for a person, and no agent's policy lifts that (only a
  project admin can, for one trigger's runs, with `--allow-unattended`).
  Keep it on them, and add it to any such tool you write.
- **Order events are untrusted.** `woo.check-order-event` runs before
  any model sees an event and keeps typed fields only; the agent that
  reads events (`order-reviewer`) has read-only tools. Keep it that way:
  an agent's guardrails check its answer after the turn, so they can't
  stop a tool call.
- **The store agent's instructions are a prompt block:** their text is
  `blocks/store-agent-prompt.liquid`, the block's file
  `blocks/store-agent-prompt.json`. Change them there, and give the block
  a new version in its file when you do, within the agent's range: a
  deploy refuses a version whose content changed.
  `agents/store-agent/index.test.ts` checks they still name every tool
  that waits for a person.
- **The store's password is a secret** (`WOO_APP_PASSWORD`): never write
  it in a file, a test or the chat, and never ask the person to copy it.
  The pack's `connect-store` script connects a store: one of its
  administrators approves Kindgi in wp-admin, and the script saves the
  password in Kindgi itself (README.md, Connect your store).

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

After the agents ship, people correct their answers, and each correction
becomes a case in the agent's test set. To fix what they corrected, see the
`kindgi-fix-corrections` skill: a setting or the wording becomes a
suggested change, checked on that test set; a rule changes in code, with a
pack test. Pinning stays with the person, and a correction that would
loosen a rule goes to the agent's owner.

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
