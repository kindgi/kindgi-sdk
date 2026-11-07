---
"@kindgi/api": patch
---

Without an authorization store, a refusal on `/v1/connection-apps` says who a tenant admin is there, as the webhook endpoints and compliance routes do: "Only a tenant admin reads or changes this workspace-wide setting. This runtime has no authorization store, so a tenant admin is the deployment's API token, an admin key, or a console signed in with either." The API reference's 403 for these routes says so too. The answer stays `403 permission-denied`.

The API reference says which of a suspended run's waits are `unattributed` in `waitingFor.other`: a wait that isn't an approval's, a connect's or one of `tokens`, or whose approval, connect or token can't be read. It said a wait no approval is linked to, but a connect's wait and one listed in `tokens` aren't `unattributed` either. The field and its values don't change.
