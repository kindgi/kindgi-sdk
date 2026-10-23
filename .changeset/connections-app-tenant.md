---
"@kindgi/api": patch
"@kindgi/connections-inmemory": patch
"@kindgi/client": patch
---

**A registration names its app's directory: `oauth2.tenant`.** For an app whose sign-in happens in a directory of its own (Microsoft's tenant), `POST /v1/connection-apps` and `PATCH /v1/connection-apps/{appId}` take `oauth2.tenant`: Microsoft's tenant id or domain for a single-tenant app, or `organizations`, `common` or `consumers` for a multi-tenant one. The registration's answer shows it. The route checks that it's a string of 1 to 253 characters; the server's binding answers `connection-app-invalid` (`details.field` `oauth2.tenant`) when the app needs one and it's missing (Microsoft's always does), when the app has no directory, or when it isn't a directory's name. A `PATCH` that gives `oauth2` gives the whole of it, the tenant included. `ConnectionOAuth2App` in the OpenAPI document, and the TypeScript and Python clients, have the optional `tenant`.
- `@kindgi/connections-inmemory` checks it the same way, and its consent page is in the registration's directory, asking for the sign-in's and the account lookup's scopes too.
