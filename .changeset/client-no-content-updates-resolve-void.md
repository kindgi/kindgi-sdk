---
"@kindgi/client": patch
---

**`projects.update`, `orgs.update` and `teams.update` resolve to nothing, as their routes answer `204 No Content`.** Each was typed as returning the updated record (`ProjectShape`, `OrgRecord`, `TeamShape`), but the API sends no body, so the call always resolved to `undefined` and a field read off the result failed at run time. They now return `Promise<void>`, like `tenant.update` and the other updates whose routes answer 204. To see the record after a change, read it with `get`. Code that awaits the call and ignores the result is unchanged.
