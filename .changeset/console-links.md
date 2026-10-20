---
"@kindgi/api": patch
"@kindgi/env-schema": patch
"@kindgi/client": patch
---

**A deployment can show links of its own in the console.** `GET /v1/auth/sign-in-options` gains an optional `links: [{ label, url }]`: the deployment's own links, such as its help desk, status page or data processing terms, for the console to show on every page, the sign-in page too. They come in the order the operator gave, with each label trimmed and each URL as a browser reads it. The answer has no `links` when there are none, and older servers leave it out too.
- `createApp`'s new `consoleLinks` sets them. It throws on more than 8 links, on a label that isn't 1 to 40 characters once trimmed or has a control or format character (as a site's display name, `hasHiddenCharacters`), and on a URL that isn't an absolute https URL with no username or password.
- `@kindgi/env-schema` adds `KINDGI_CONSOLE_LINKS`, a JSON object of label to URL, for a runtime to read them from.
- The TypeScript and Python clients' sign-in options gain `links`. The OpenAPI document names the item `ConsoleLink`.
