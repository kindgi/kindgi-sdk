---
"@kindgi/connections": patch
---

**Tools that act with a connection, and `appFetch` to write more.**
- **`@kindgi/connections/app-fetch`: `appFetch(ctx, call)`** calls an app's API with one of the call's connections. Its token goes as the only `Authorization`. Calls are paced by the entry's rate limits, per connection. A busy answer is tried again: a 429, a 503 to a GET, or a 403 that says a rate limit is spent, with 3 tries in all and never a wait past 30 s. A 401 throws `ConnectionRejectedError`, so the runtime renews the token once.
- **Each tool is a factory, and a pack names its id.** A tool id is the tenant's, filed under the first project that publishes it, so a pack includes `gmailSend({ id: 'acme.gmail.send' })` under its own id. There's no default.
  - `@kindgi/connections/google/tools`: `gmailSend` sends a plain-text mail as the person whose Google connection the call has.
  - `@kindgi/connections/github/tools`, on the company's GitHub connection: `githubIssuesList`, `githubLabelsList`, and `githubIssuesAddLabels`, which adds only labels the repository has.
  - Sending and labelling are `mutating`, and wait for a person's yes in a run no person started.
