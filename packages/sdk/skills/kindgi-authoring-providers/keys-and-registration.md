# Mental model: keys, registration and fallbacks

```
Project .env / .env.local    dotenv SecretBinding       runtime ProviderRegistry
─────────────────────────    ─────────────────────       ────────────────────────
ANTHROPIC_API_KEY=sk-...  →  resolve('local',            hydrated per tenant on first
                                'ANTHROPIC_API_KEY')     access; each row =
                                                          { metadata, adapter_id,
                                                            secret_ref?,
                                                            adapter_config? }
                                     │                          │
                                     ▼                          ▼
                             adapter factory ──── resolves apiKey lazily via closure
                                     │
                                     ▼
                             ModelProvider ────── router picks a (provider, model)
                                                   tuple when an agent's
                                                   capabilities.needs matches
```

Three moving parts:
1. **API key on disk** — in `kindgi dev` (environment `local`) the dotenv
   secret binding reads the project's own env files: `.env`, then
   `.env.local` on top (change the list with `dev.envFiles` in
   `kindgi.config.ts`, `envFiles` under `[tool.kindgi.dev]` in a Python
   pack's `pyproject.toml`, or `dev.envFiles` in a Java or Scala pack's
   `kindgi.config.json`), then Kindgi's own `.kindgi/secrets.env` on top.
   A key already in the app's `.env` just works. `kindgi secrets set`
   (interactive, no-echo) writes `.kindgi/secrets.env`, a file the app
   doesn't load (a framework loads `.env.local` into every route); `--app`
   writes the app's file instead, for a value the app reads too (a webhook
   signing secret). For non-sensitive values (log levels, region names,
   feature flags), `kindgi env set NAME VALUE --env=local` writes the app's
   `.env.local` with a positional value — never route real secrets
   through it. `KINDGI_*`
   names configure Kindgi itself and are never resolvable as secrets.
2. **Provider registration** — declared in the pack's config, which is
   committed, and registered by `kindgi dev` at each boot; on a runtime
   `kindgi dev` doesn't run, `kindgi providers register` (`POST /v1/providers`)
3. **Agent's `capabilities.needs`** — matched at the (provider, model) tuple level at turn time

**Registration body:** `{ metadata, adapter_id, secret_ref?, adapter_config? }`.
`secret_ref` points at the credential; `adapter_config` holds the adapter's
non-secret connection settings (a cloud project, a base URL) as flat string,
number or boolean values. Both are stored with the provider and handed to the
runtime; `kindgi providers list` / `get` show only `metadata`. Never put a
credential in `adapter_config`.

**Shape rule:** `ProviderMetadata.id` names the CONNECTION (e.g. `anthropic`,
`groq`, `local-onnx`); per-model fields (`name`, `contextWindow`, `cost`,
`features`) live inside `metadata.models[]`. One row can expose many models
under the same API key.

**Thinking:** a model that thinks has `thinking` in its entry:
`{ "mode": "adaptive", "lowest": "low", "default": "low" }`. `lowest` is
the vendor's own setting for the least thinking, and optional `levels`
lists the others it takes. `default` (optional) is the level a call that
asks none is sent: `lowest` or one of its levels, else the registration is
refused, naming the ones it takes. It needs runtime 0.3.0 or later; an
older one refuses it. The registration is per tenant, so each tenant's
registration sets its own. An agent's model-settings `thinking` wins over
it, and without either the call sends no level, so the model thinks as its
vendor sets. A guardrail's or an eval's model judge asks for `lowest`. The
presets set no `default`: for one, register the model as a spec.

**Fallbacks:** `"fallback": true` in `metadata` makes a provider a
fallback — the router considers it only when no other provider satisfies
the agent's capability, and the turn's result then carries a
`fallback-provider` warning. `dev-echo` is one; a cheap local model can be
yours.
