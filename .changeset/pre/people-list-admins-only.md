---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

Who can read the tenant's people, and how a project admin adds one.
- **The people list is for tenant admins:** `GET /v1/identity/users` answers anyone else `403 permission-denied`. Reading a person's record (`GET /v1/identity/users/{userId}`) or sessions (`…/sessions`) needs a tenant admin, or that person.
- **Add a project member by email or id:** `POST /v1/projects/{projectId}/memberships` takes exactly one of `userId` and `email`. The runtime looks the person up among the tenant's people: someone who isn't one, or was removed, is `404 identity-user-not-found`, and nothing is added. The answer has their `userId`. A directory names the email lookup with the optional `IdentityDirectoryBinding.findUserByEmail`; without it, an email is `400` and an id still works.
- **`GET /v1/projects/default`** needs read on the Default project, as `GET /v1/projects/{projectId}` does: someone with a role on another project only gets `403`.
- **A member API key administers below the tenant:** it's refused `admin` on the tenant only, as the API keys design has it, so a project admin's member key adds and changes that project's members. Before, it was refused every `admin` action, and a project admin who isn't a tenant admin can't hold an `admin` key.
- **Clients:** TypeScript `projects.memberships.add(projectId, { email, role })`; the Python client is regenerated.
