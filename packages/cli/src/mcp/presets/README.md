# `kindgi mcp` presets — authoring guide

Each `*.json` file in this directory is one MCP-server preset consumed
by `kindgi mcp add <kind>`. The filename stem is the `kind` — how users
reach the preset from the CLI.

## Schema

See `packages/cli/src/mcp/preset-types.ts` for the authoritative TypeScript
shape. In brief:

```json
{
  "kind": "postgres",                        // must match filename stem
  "description": "one-line summary",         // shown by `kindgi mcp presets`
  "runtime": "npx" | "docker",               // how the launcher spawns it
  "package": "<npm-name-or-docker-image>",
  "envMap": [
    { "child": "DATABASE_URI", "from": "$SECRET" }   // "$SECRET" = user's --secret=<name>
  ],
  "defaultArgs": ["--access-mode=restricted"],       // passthrough args after `--`
  "hostRemap": "docker-desktop",                     // (optional) localhost fixup for Docker on Mac
  "audit": {
    "urlLeakInErrors": "pending",                    // "verified-safe" | "pending" | "known-issue"
    "reviewedAt": null,                              // ISO date once audited
    "version": null,                                 // npm/docker tag audited
    "notes": "..."                                   // freeform
  }
}
```

## Adding a preset

1. Create `<kind>.json` (filename == the `kind` field).
2. Fill in the fields above. Start with `audit.urlLeakInErrors: "pending"` —
   never claim `"verified-safe"` without a real inspection.
3. If the underlying MCP server is Docker + you're targeting local dev on
   Mac / Windows, set `"hostRemap": "docker-desktop"` so the launcher
   rewrites `@localhost` / `@127.0.0.1` in resolved secret values to
   `@host.docker.internal`.
4. Run `pnpm --filter @kindgi/cli test preset` to confirm the loader
   accepts your JSON.

## Audit obligations

Every preset carries an `audit` block. Before flipping
`urlLeakInErrors` to `"verified-safe"`:

- **Read the server's source** for every place it constructs an error
  message, log line, or debug-mode dump. Confirm the secret env var
  never appears.
- **Poke the server** with malformed queries (`docker run` it locally,
  send garbage over stdio) and grep stdout/stderr for the URL/token
  substring.
- Record the version (`npm ls <pkg>` or `docker image inspect`) in
  `audit.version` and today's ISO date in `audit.reviewedAt`.

A `kindgi mcp verify` command that automates this check is planned.

## Only `$SECRET` is a supported template today

`envMap[].from` accepts only the literal string `"$SECRET"`, which
substitutes with the `--secret=<name>` the user passes to
`kindgi mcp add`. This narrows the surface area intentionally — most
MCP servers want exactly one secret in one env var. When we see a
consumer needing multiple named secrets or per-env-var overrides,
we'll widen the template DSL (candidate shapes:
`${SECRET:OTHER_NAME}`, `${LITERAL:some-value}`).
