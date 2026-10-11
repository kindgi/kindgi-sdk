---
'@kindgi/api': patch
'@kindgi/client': patch
---

Sites that sign their own people in to one project. A site, such as a store's WordPress admin, vouches for whoever is signed in there, so the store's staff ask the project's agents and decide its approvals as themselves, without a Kindgi account. A decision's record names the person.

**What the API package adds** (mounted only when a deployment supplies the new `SiteBinding`):
- **`/v1/projects/{projectId}/sites`, for tenant admins:** register, list, read, change, pause, resume, unregister, issue a new enrollment code, and revoke a key.
  - Settings are checked before the binding sees them: an https origin, an approvals URL on that origin (compared as origins, not as a prefix), a role map that only names allowed roles, no reviewer role above the site's ceiling and never `admin`, and a display name without control or bidirectional characters.
- **`POST /v1/auth/sites/enroll`, public:** a site posts its Ed25519 public key with its one-time code.
- **`POST /v1/auth/site-sign-in`, public:** a site exchanges one of its people's statements (a compact JWS) for a session limited to the site's project.
- **Both public routes** cap the body at 4096 bytes, pass the client's address to the binding, and leave every other check to it. Refusals are `401 site-enrollment-refused` and `401 site-sign-in-refused` (with `details.reason`), and limits are `429 rate-limit-exceeded`.

**The clients:** the TypeScript client gains `client.projects.sites`, `client.auth.enrollSite` and `client.auth.siteSignIn`; the Python and JVM clients gain the same operations.
