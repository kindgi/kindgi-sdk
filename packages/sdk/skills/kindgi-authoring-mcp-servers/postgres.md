# Postgres, and the steps every preset follows

Best-worn path. Uses `crystaldba/postgres-mcp` via Docker with
read-only access mode by default.

**Step 1 — set the DB URL** (interactive, no-echo):

```sh
kindgi secrets set MY_DB_URL --env=local --scope=tenant
# paste postgres://user:pass@host:port/db, press enter
```

For pipelines/CI: `pbpaste | kindgi secrets set … --from-stdin`, or
`--from-file=<path>` on a mode-0600 file. Never pass the value on argv.

**When the CLI is signed in to a hosted runtime:** the launcher reads only
the pack's env files, and `--env=local` is the env of the `kindgi dev`
runtime that writes them. Run the command in the pack while `kindgi dev`
runs there: the CLI talks to that runtime, unless `--url` or
`KINDGI_API_URL` names another. Or the user adds the line to `.env.local`
by hand. With no `kindgi dev`, the value would go to the hosted runtime,
where the launcher never reads it; a runtime that keeps its values under
one env refuses it (`env-not-served`).

**Step 2 — wire the MCP server:**

```sh
kindgi mcp add postgres --secret=MY_DB_URL
```

Writes `.mcp.json` at the pack root (or merges into an existing one).
The server name defaults to `my_db` (derived from the secret
name — see `several-servers.md`). Override with `--server-name=<label>`.

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
