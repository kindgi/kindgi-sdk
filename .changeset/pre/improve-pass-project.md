---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A pass started by hand works in the project its scope is in.** `POST /v1/proposals/improve` takes an optional `projectId`, as an improve schedule does: the project the pass works in, where its test set must be one that project's runs can use and its eval runs run. Left out, it's the scope's project for a project or segment scope, and the agent version's for the tenant or an org. Before, a pass always worked in the agent version's project, so one scoped to another project couldn't use a test set made from that project's judged runs. A project or segment scope must be in the pass's project, the version must be one that project's runs can use, and a project other than the version's needs `write` there, as the pass's eval runs do. The TypeScript and Python clients take `projectId`, and `kindgi proposals improve` takes `--pass-project=<project-id>` for a tenant or org scope.
