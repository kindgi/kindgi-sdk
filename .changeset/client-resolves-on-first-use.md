---
"@kindgi/sdk": patch
---

`createClient()` from `@kindgi/sdk/client` now finds its settings (`KINDGI_API_URL`, `KINDGI_API_TOKEN`, or the running `kindgi dev`) when the client is first used, not when it's created. A module-scope `const kindgi = createClient()` no longer breaks a production build that runs without them: `next build` loads every route's module with `NODE_ENV=production`, and before this fix that threw. When they're still missing, the first use (`kindgi.runs`, …) throws the same error naming what to set; once they're set, the next use works. The warnings stay one-time, and the client's type is unchanged.
