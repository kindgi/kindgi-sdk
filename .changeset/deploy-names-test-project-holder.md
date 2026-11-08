---
"@kindgi/api": patch
---

**A deploy refused as another project's says when that's a test project.** `POST /v1/deployments` still answers `409 <primitive>-project-mismatch`, with the same code and details; only its message changes:

- **Where the ids are live, when that's a test project** (`Project.testFor`), as far as the caller may know it: `it's live in your test project "<name>" (<projectId>)` when it's their own, `it's live in the test project "<name>" (<projectId>)` when they can read it (every project, on a runtime without an authorization store), and `it's live in another person's test project` otherwise. Any other project is never named, as before, and the log keeps its id (`ownerProjectId`) either way.
- **No environment order fix where either side is a test project.** A test project joins no environment order, so on a runtime with one pack service the words say that instead: its builds can't be promoted to another project, or, for a deploy into one, it takes only ids no other project holds. With a pack service per deployment, the fix is still a copy of the pack with its own pack id.
- **A project that can't be read** (the store unreachable) leaves the message as it was, and a warn says so.
