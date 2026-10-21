---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A tenant admin lets one of a site's people removed in Kindgi back in, through their site.** `POST /v1/projects/{projectId}/sites/{siteId}/people/{userId}/restore` is for someone removed with `POST /v1/identity/users/{userId}/unregister` while the site still knows them. They're in the tenant again, the same person, with their history, and their next sign-in through the site is theirs again. Their grants come back with that sign-in, from the site's role map then; their API keys and sessions stay gone. It answers `200 { user }`.
- It's refused, with nothing changed, as `409 site-person-restore-refused` with `details.reason`:
  - `not-removed`: they're in the tenant and their site still knows them;
  - `left`: their site said they left it. A site forgets a person who leaves, so if they come back, it signs them in as a new person;
  - `linked-elsewhere`: they also sign in another way (through another site, or the tenant's own sign-in), and letting them back in would open that too. Add them again instead, as a new person.
- A site with no link to that person is `404 site-person-not-found`.
- `SiteBinding` gains an optional `restorePerson` (`SitePersonRestoreInput`, `SitePersonRestoreOutcome`, `SitePersonRestoreRefusal`). The route is mounted only when a deployment's binding has it.
- The TypeScript client gains `projects.sites.restorePerson(projectId, siteId, userId)`, and the Python client `projects.sites.restore_person`.
- The CLI gains `kindgi sites restore-person <site-id> <user-id> [--project=<project-id>]`.
