---
"@kindgi/api": patch
---

**A HEAD request is checked as its GET.** A route answers a HEAD with its GET handler: the GET's status and headers, without the body. Some routes' checks looked for GET alone, so a HEAD skipped them, and a caller without the right got the GET's status and headers, its `content-length` too. Those were the env and secrets lists, the agent, flow, tool, guardrail and test set lists in a project, a project (and `/v1/projects/default`), an org, a team, a run, and a run's provenance. Others asked a HEAD for more than its GET: an agent, flow, tool, guardrail, test set or MCP endpoint, a project's members, team grants and queue rules, the approvals a tenant admin reads, and the reviewer roster. Now every route asks a HEAD for the same right as its GET. Without it, both are `403`; with it, the HEAD answers as the GET. A page cursor in a HEAD is opened as in a GET, so a sealed one from another list or caller is `400 bad-input` for both.
