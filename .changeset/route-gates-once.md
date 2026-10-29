---
"@kindgi/api": patch
---

**A request is checked once, and the access audit records its decision once.** Nine routers registered a gate both on a path and on its `/*` form, which matches the path too, so a request to the path itself passed the same gate twice: two checks, and, when allowed, two identical rows in the access audit. They were the list and create routes of a project's judging rules, a project's judging queue, a project's sites and the tenant's sign-in providers, and reading one agent, flow, tool, guardrail, eval suite or MCP endpoint. Each gate is now registered once, on the `/*` form, and decides as before: no route answers differently, and a refusal was always recorded once.
