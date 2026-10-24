---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**On a runtime without an authorization store, the tenant's settings are a tenant admin's to change, as they are with one.** Before, such a runtime checked nothing on them, so a member key, or anyone signed in, could change them. Now anyone else gets `403 permission-denied`.
- **A change needs the tenant admin:** to model providers (`/v1/providers`), policies, adapters, the trusted signing keys, and the sign-in provider catalog (`/v1/auth/providers`). Reading them stays open to everyone.
- **Every call needs the tenant admin,** reads too: to the outgoing webhook endpoints (`/v1/webhook-endpoints`) and the compliance evidence (`/v1/compliance`).
- **Without a store, a tenant admin** is the deployment's API token, an `admin` key, or a console signed in with either, as `whoami`'s `tenantAdmin` says. A person signed in with an identity provider or an emailed link isn't one, and nor is a `member` key or a key limited to a project.
- **Deployments don't change:** a runtime without a store still lets every caller deploy. Deploying is project work, which such a runtime leaves to everyone.
- **The spec lists the `403`** on each of these operations.
- **`kindgi people add`'s hint** says a project role is for a runtime with authorization on; without it, the person can work in every project already. Before, it told everyone to give them a project role, which a runtime without a store has none of.
- **`kindgi export workspace`** skips the webhook endpoints and the compliance evidence for someone who isn't a tenant admin ("it needs a tenant admin"), and names them in its warning. Before, it asked for them, was refused, and recorded them as failed.
