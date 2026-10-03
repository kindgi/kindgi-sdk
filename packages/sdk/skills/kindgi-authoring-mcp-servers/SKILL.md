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
version: "0.3.0"
sdk_version: "0.0.0"
pack_languages: [node, python]
---

# Wiring an MCP server for a Kindgi pack

> **Running `kindgi`:** in a Node project the CLI is a devDependency
> (`@kindgi/cli`), not a global command. Run it through the project's
> package manager — `pnpm exec kindgi …`, `npx --no kindgi …` (npm),
> `yarn kindgi …` or `bun run kindgi …`. A Python pack (`[tool.kindgi]` in
> `pyproject.toml`) has no Node project: run the `kindgi` on `PATH`.
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
  need to restart their MCP client after `kindgi mcp add` (see gotcha
  #2 below).

## Mental model

```
Kindgi's SecretBinding      .mcp.json (pack root)      launcher subprocess       MCP server subprocess
─────────────────────       ────────────────────       ──────────────────        ────────────────────
MY_DB_URL=…       →  { "command": "pnpm",    →  reads .env +         →   spawns child with
(.env / .env.local, or           "args": ["exec","kindgi", .env.local (the      DATABASE_URI in env,
 `kindgi secrets set`)            "mcp-launch", "--", …] } pack env files),     stdio piped to CC
                                     │                   substitutes secret       ▲     │
                                     │                   into child env           │     ▼
                                     ▼                          │            MCP protocol (stdio)
                            Claude Code / Cursor spawns          │             ▲     │
                            `kindgi mcp-launch …` at             │             │     ▼
                            startup ─────────────────────────────┘         ┌─────────────────┐
                                                                            │  Claude Code    │
                                                                            │  (or Cursor…)   │
                                                                            └─────────────────┘
```

Three moving parts:

1. **The secret on disk** — for `local`, the project's env files at the
   pack root (`.env`, then `.env.local`; `dev.envFiles` to change);
   other environments use `.env.<envName>`. Add it by hand or with
   `kindgi secrets set` (interactive no-echo prompt; never the value on
   argv), which writes `.env.local`. See `kindgi-authoring-providers`
   for the same flow used for LLM API keys.
2. **`.mcp.json` at the pack root** — Kindgi writes this via
   `kindgi mcp add`. Every entry runs the project's own `kindgi
   mcp-launch -- <launcher-flags>...` through its package manager
   (`"command": "pnpm", "args": ["exec", "kindgi", "mcp-launch", …]`;
   npm: `npx --no kindgi …`) — never a global `kindgi`, never a
   download. A Python pack has no Node project, so its entries run the
   `kindgi` on `PATH` (`"command": "kindgi", "args": ["mcp-launch", …]`).
   The file is safe to commit — it references secrets by NAME, not
   value.
3. **The launcher** — `kindgi mcp-launch` is what the coding agent
   actually spawns. It reads the referenced secret from the pack env files,
   injects it into the child MCP server's env, and pipes stdio through.

## Path A — Postgres

Best-worn path. Uses `crystaldba/postgres-mcp` via Docker with
read-only access mode by default.

**Step 1 — set the DB URL** (interactive, no-echo):

```sh
kindgi secrets set MY_DB_URL --env=local --scope=tenant
# paste postgres://user:pass@host:port/db, press enter
```

For pipelines/CI: `pbpaste | kindgi secrets set … --from-stdin`, or
`--from-file=<path>` on a mode-0600 file. Never pass the value on argv.

**Step 2 — wire the MCP server:**

```sh
kindgi mcp add postgres --secret=MY_DB_URL
```

Writes `.mcp.json` at the pack root (or merges into an existing one).
The server name defaults to `my_db` (derived from the secret
name — see "Server naming" below). Override with `--server-name=<label>`.

**Step 3 — restart your MCP client.** MCP servers are loaded at client
startup — a fresh `.mcp.json` doesn't take effect mid-session:
- **Claude Code:** exit + `claude` again in the same pack dir
- **Cursor:** ⌘⇧P → "Restart Extension Host" (or restart the app)
- **Claude Desktop:** quit + reopen
- **Windsurf:** Command Palette → "Restart Windsurf"

**Step 4 — use it.** Tools like `execute_sql`, `list_tables`,
`analyze_index_health` now appear. Ask the agent things like "what
tables are in this schema?" or "what's the shape of the customers
table?" or "how many rows are in orders where created_at > 2024?".

## Path B — Multiple servers in the same pack

Two connections against different DBs? Two `mcp add` invocations,
each with its own `--secret` and `--server-name`:

```sh
kindgi secrets set MY_DB_URL --env=local --scope=tenant
kindgi secrets set ANALYTICS_DB_URL --env=local --scope=tenant

kindgi mcp add postgres --secret=MY_DB_URL --server-name=my_db
kindgi mcp add postgres --secret=ANALYTICS_DB_URL --server-name=analytics_db
```

`.mcp.json` gets two entries. The agent picks the right one by name
when it invokes a tool (e.g. `my_db.execute_sql`).

## Server naming

`--server-name` defaults are derived from the secret name:

| Secret name | Default server name |
|---|---|
| `MY_DB_URL` | `my_db` |
| `ANALYTICS_DB_URL` | `analytics_db` |
| `ANTHROPIC_API_KEY` | `anthropic_api` |
| `GITHUB_PAT` | `github` |
| `DB_PASSWORD` | `db` |

The suffix-stripping (`_url` / `_uri` / `_key` / `_token` / `_pat` /
`_secret` / `_password`) is intentional — the server name should
describe the *resource*, not the *credential shape*. Override with
`--server-name=<label>` when the default reads wrong.

## Path C — Non-Claude-Code clients

`.mcp.json` at the pack root is what Claude Code reads natively. Other
clients read from their own paths (`.cursor/mcp.json`, `.vscode/mcp.json`,
Claude Desktop's system-wide config). To bridge:

1. Establish a symlink from the client's expected path to `.mcp.json`:
   ```sh
   mkdir -p .cursor && ln -sfn ../.mcp.json .cursor/mcp.json
   ```
2. Restart the client.

Symlinks work because the FILE CONTENTS are portable across every MCP
client — the `mcpServers` block has the same shape everywhere. Only
the file LOCATION differs. Edits to `.mcp.json` flow through
automatically via the symlink; no re-sync needed.

Windows users without dev-drive symlinks: `cp .mcp.json .cursor/mcp.json`,
and re-copy after every `kindgi mcp` edit.

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
gotcha #4.

## Common mistakes

1. **Reading `.mcp.json` mid-session and asking about it.** `.mcp.json`
   references secrets by NAME (e.g. `secret:MY_DB_URL@local:tenant`),
   not by value. Safe to Read + describe to the user. **Do NOT** run
   `cat .env`, `env | grep`, or Read `.env` / `.env.local` — those return
   the raw URL, which enters your transcript, gets sent to the model
   provider on every subsequent turn, and can be exfiltrated via
   prompt injection. Once a secret is in a model's context, it's a
   rotation event, not a "clean up the log" event.

2. **Expecting the new server to activate without a restart.** MCP
   servers are loaded at client startup. `kindgi mcp add` writes the
   config file; the CLIENT doesn't re-scan it until a restart. Tell
   the user to restart their client after `mcp add`, and don't call
   MCP tools before that restart happens in your current session.

3. **`--env` / `--scope` mismatch between `secrets set` and `mcp add`.**
   Both flags need to agree — the launcher looks up the secret using
   whatever `--env` + `--scope` you passed to `mcp add`. Default is
   `--env=local --scope=tenant`; match this on both commands.

4. **Trusting a preset's audit metadata that says `pending`.** Every
   preset carries `audit.urlLeakInErrors`. Only `"verified-safe"` means
   someone has confirmed the wrapped MCP server doesn't echo the
   secret in its error/debug output. `"pending"` means the audit
   hasn't run — the server may or may not leak. When you see a
   `pending` preset in a session that handles real credentials, tell
   the user: "this preset works but its URL-echo safety isn't
   verified for this version; watch tool error messages for the raw
   URL, and file feedback if you see one."

5. **Trying to use MCP against a `localhost` DB from Docker on Mac
   without the host-remap.** Docker containers on Mac can't reach the
   host's `localhost`. The `postgres` preset carries `hostRemap:
   "docker-desktop"`, which the launcher applies automatically — it
   rewrites `@localhost` / `@127.0.0.1` in the resolved URL to
   `@host.docker.internal` before injecting into the container's env.
   If you author a preset with a Docker runtime + a localhost
   consumer, include `"hostRemap": "docker-desktop"` in the preset JSON.

6. **`kindgi mcp add` fails with "Secret X not in .env, .env.local".** The
   secret hasn't been stored yet. Run `kindgi secrets set X --env=local
   --scope=tenant` first. The error message includes this fix pointer.

## Security discipline

The invariants this skill inherits — every bullet here is enforced by
you, the coding agent, in the session where MCP is wired:

- **Never Read `.env`, `.env.local` or `.env.<envName>` files.** Their contents are the raw
  secret values. Reading them puts the secret in your tool result and
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
