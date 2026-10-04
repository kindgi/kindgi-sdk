---
"@kindgi/sdk": patch
---

**`createClient()` from `@kindgi/sdk/client` finds the runtime by itself.** Every option is optional now:
- `apiUrl` and `auth` come from `KINDGI_API_URL` and `KINDGI_API_TOKEN`;
- in development, when those aren't set, from the running `kindgi dev` (the nearest `.kindgirc.json`), with a one-time warning to put them in your env file (`.env` / `.env.local`);
- a token that doesn't match the running `kindgi dev`'s for the same URL (after `kindgi dev --reset`) is warned about once.

Production (`NODE_ENV` or `KINDGI_ENV` = `production`) never reads `.kindgirc.json`, and a missing setting there is an error that says what to set. Explicit options win, field by field. `@kindgi/client`'s `createClient` stays the explicit client underneath (and the one for browsers).
