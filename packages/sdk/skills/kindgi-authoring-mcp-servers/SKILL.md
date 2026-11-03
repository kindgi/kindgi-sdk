---
name: kindgi-authoring-mcp-servers
description: >
  Wire an MCP server into a Kindgi pack so the coding agent (Claude Code,
  Cursor, VS Code, Windsurf, …) can discover a live external resource
  through tools instead of asking the user to paste schemas or values.
  Uses `kindgi secrets set` for the credential (interactive, no-echo) and
  `kindgi mcp add <preset>` to write `.mcp.json` at the pack root. The
  launcher (`kindgi mcp-launch`) spawns the actual MCP server as a
  subprocess with the secret injected into its env — never onto the
  model's transcript. Load this when the user says "I have a Postgres
  URL, can you look at the schema", "connect to my database", "wire
  MCP", "add a Postgres MCP", "let CC query my DB", "I don't want to
  paste my table shape", or when the model is about to ask the user to
  paste external schema/data that Kindgi could discover through MCP.
  Credential storage is covered by kindgi-authoring-providers's
  `kindgi secrets set` flow.
type: core
library: "@kindgi/sdk"
version: "0.4.0"
sdk_version: "0.0.0"
pack_languages: [node, python, java, scala]
---

# Wiring an MCP server for a Kindgi pack

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no -- kindgi …` (npm),
> `yarn kindgi …` or `bun run kindgi …`. A Python pack (`[tool.kindgi]` in
> `pyproject.toml`) has no Node project: run the `kindgi` on `PATH`. A Java
> or Scala pack (`kindgi.config.json`) runs the CLI it pins: `./kindgiw …`.
> Commands below are written `kindgi …` for brevity.

If the user has an external resource (Postgres DB, GitHub org, Notion
workspace, …) that would be useful to a coding agent, **wire an MCP
server** rather than asking the user to paste values. Kindgi keeps the
credential out of the model's transcript by injecting it into the
subprocess's environment; the model only sees the tools the MCP server
exposes.

## When to reach for this

Reach for MCP when the user hands you a live external resource by
reference (URL, host + credential, workspace id). Signals from the
user:
- "I have a Postgres database at $URL"
- "Connect to my Notion workspace at $TOKEN"
- "Let CC look at the schema of my DB"
- "Don't paste it, just query it"

**Do NOT reach for MCP when:**
- The resource is a static file the user has locally (just Read it).
- The resource is best-inspected once by a human (a one-shot answer, no
  agent tools needed).
- The user is in a client that hasn't loaded `.mcp.json` yet — they'll
  need to restart their MCP client after `kindgi mcp add` (mistake 2 in
  `common-mistakes.md`).

## Your case: read this file

| Your case | Read |
|---|---|
| How the secret reaches the server and never the model: `.mcp.json` and the launcher | [how-it-works.md](how-it-works.md) |
| Postgres, and the steps every preset follows: set the secret, add the server, restart the client | [postgres.md](postgres.md) |
| Several servers in one pack, or a server's name | [several-servers.md](several-servers.md) |
| Cursor, VS Code, Claude Desktop or Windsurf | [other-clients.md](other-clients.md) |
| An error, a server that doesn't show up, or a preset whose audit says `pending` | [common-mistakes.md](common-mistakes.md) |

## Verifying end-to-end

```sh
# 1. Check the secret exists
kindgi secrets list --env=local --scope=tenant

# 2. Check .mcp.json
kindgi mcp list

# 3. Check available presets
kindgi mcp presets
```

`kindgi mcp list` prints the configured servers with their launcher
argv shape. `kindgi mcp presets` shows what presets are available and
their audit status. If the postgres preset audit says
`urlLeakInErrors: "pending"`, that's a known unresolved item — see
mistake 4 in `common-mistakes.md`.

## Security discipline

The invariants this skill inherits — every bullet here is enforced by
you, the coding agent, in the session where MCP is wired:

- **Never Read `.env`, `.env.local`, `.env.<envName>`, `.kindgi/secrets.env`
  or `.kindgi/dev/runtime.env`.** Their contents are the raw secret values. Reading them puts the secret in your tool result and
  from there in every subsequent turn's context sent to the model
  provider.
- **Never run `env | grep SECRET_NAME`, `printenv SECRET_NAME`, or
  equivalent** in a bash tool. Same failure — the value returns in the
  tool result.
- **When a tool errors, check the error message before summarizing.**
  Some MCP servers echo the connection string in `connection refused`
  errors. If you see the URL in a tool error, redact when
  summarizing to the user, and file the incident via the
  `kindgi-framework-feedback` skill so the preset's audit gets updated.
- **Prefer `kindgi mcp list` over Reading `.mcp.json`** when the user
  asks "what's configured?" — the list output has the same info in a
  cleaner shape and is safe to include in your reply.
- **Never repeat the resolved URL back to the user** — even in a
  "here's what I wired up" summary. Refer to the secret by NAME and
  to the server by its `.mcp.json` label. The point of MCP is that
  the value stays out of every layer that a model can see; repeating
  it in your reply defeats the invariant.

## When the framework itself is the problem

If you diagnose that the bug lives in Kindgi/`@kindgi/cli` itself
(`kindgi mcp add` writes malformed JSON, `mcp-launch` hangs, a preset
has bad `defaultArgs`, launcher can't resolve a secret that clearly
exists in the pack env files, an MCP server echoes the URL in its
error tool result) — not in your pack's `.mcp.json` or secret setup —
load the `kindgi-framework-feedback` skill and file a structured
report with `kindgi feedback write`. That diagnostic is high-signal
input the maintainers can act on; don't let it disappear into the
transcript.
