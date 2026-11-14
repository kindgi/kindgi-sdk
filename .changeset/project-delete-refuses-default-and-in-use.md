---
"@kindgi/platform": patch
---

**The workspace's default project can't be deleted, and neither can a project something the workspace keeps still names.** `ProjectBinding.delete` checks, in this order, and the first that holds answers: no such project (`ok`, as before), the default (`project-is-default`), a member of an environment order (`project-in-environment-order`), still in use (`project-in-use`). A refusal deletes nothing.

- `ProjectDeleteOutcome` gains `{ kind: 'project-is-default' }` and `{ kind: 'project-in-use' }`.
- The in-memory reference adapter refuses the default before it asks about an order, and takes an optional `projectInUse(tenantId, projectId)` hook: compose it to whatever keeps the workspace's content where they share a store. Without it, nothing holds a project.
- The conformance suite (`runProjectBindingConformance`) always checks that the default is refused and stays, with its memberships and grants. A harness that gives `holdProject` and `releaseProject` and turns on `checksProjectsInUse` also checks that a project in use is refused and stays, and deletes once released; the flag without both hooks throws.

**Breaking for custom platform bindings.** A host that implements `ProjectBinding` returns the two new outcomes: the default answers `project-is-default` whatever else is true of it, and a binding over a database answers `project-in-use` where a row still names the project. A `switch` over `ProjectDeleteOutcome` that ends in `never` gains two cases.
