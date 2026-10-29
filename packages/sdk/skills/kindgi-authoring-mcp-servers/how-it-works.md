# How it works: the secret, `.mcp.json` and the launcher

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
   pack root (`.env`, then `.env.local`; `dev.envFiles` to change), then
   Kindgi's own `.kindgi/secrets.env`; other environments use
   `.env.<envName>`. Add it with `kindgi secrets set` (interactive no-echo
   prompt; never the value on argv), which writes `.kindgi/secrets.env`,
   or by hand. See `kindgi-authoring-providers`
   for the same flow used for LLM API keys.
2. **`.mcp.json` at the pack root** — Kindgi writes this via
   `kindgi mcp add`. Every entry runs the project's own `kindgi
   mcp-launch -- <launcher-flags>...` through its package manager
   (`"command": "pnpm", "args": ["exec", "kindgi", "mcp-launch", …]`;
   npm: `npx --no -- kindgi …`) — never a global `kindgi`, never a
   download. A Python pack has no Node project, so its entries run the
   `kindgi` on `PATH` (`"command": "kindgi", "args": ["mcp-launch", …]`). A
   Java or Scala pack's run the CLI it pins (`"command": "./kindgiw"`).
   The file is safe to commit — it references secrets by NAME, not
   value.
3. **The launcher** — `kindgi mcp-launch` is what the coding agent
   actually spawns. It reads the referenced secret from the pack env files,
   injects it into the child MCP server's env, and pipes stdio through.
