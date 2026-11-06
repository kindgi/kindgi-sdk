---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**Breaking, for API keys limited to a project, with authorization on.** Such a key reads its own project's work and what that work needs, and no longer reads the rest of the workspace:

- Rows with no project are the whole workspace's, so the key doesn't read them: artifacts, cost records, provenance records, approvals, and deployments that serve no project. A list leaves them out, and one asked for alone answers as another project's does: 404, or 403 for a cost record.
- The workspace's settings answer 403: model providers, policies, adapters, capabilities, signing keys and identity providers. So `kindgi providers list|get` and `kindgi sso providers list|get` refuse such a key.
- Of the workspace's orgs, the key reads only its project's, and it reads no team. The workspace's release gates, which apply to its project's runs, it still reads.
- In memory, it still reads its person's own facts that name no project, as the runs it starts recall them. But it writes, changes, verifies and deletes its person's facts only in its project: one that names no project answers 403 `permission-denied`, since it reaches that person's runs in every project. A sign-in limited to a project gets the same answer.
- A cost total leaves out records with no project, and a cost total for another org's scope answers 403 `permission-denied`, where it was an empty total before. `CostAggregateInput` gains an optional `includeTenantRecords`: the route sets it to `false` for such a key, and a binding that applies `readableProjectIds` applies it too.
- `kindgi doctor` skips its provider check for such a key and says why, instead of advising a restart.

A key that isn't limited to a project, and a person's own sign-in, read as before.
