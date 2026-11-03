# Several servers in one pack, and their names

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
