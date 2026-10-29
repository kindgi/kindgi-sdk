# Common mistakes

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
