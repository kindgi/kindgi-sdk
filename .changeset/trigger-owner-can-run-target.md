---
"@kindgi/api": patch
"@kindgi/authz": patch
"@kindgi/cli": patch
---

**A schedule or webhook trigger can't be set to run as a service account that can't run what it starts.** With an authorization store, registering a trigger or taking one over with `runAsServiceAccountId` (`--run-as`) now checks the account the way every fire does: `execute` on the agent or flow, or `publish` on the agent for an improvement schedule.
- An account that can't is refused with `409 service-account-cannot-run-target`, and nothing is registered or changed. The message names the account and the target, and what fixes it: give the account the editor role on the target's project, or name another account.
- Before, the trigger was made, and then every fire was refused ("may no longer run") until it paused.
- Only a caller who may name the account (`act_as`, a tenant admin's) gets this far, so nobody else learns anything new.
- Without an authorization store, nothing changes: a grant limits nothing there.

`@kindgi/authz` exports `targetAccess(target)`: the action and resource a trigger's target is checked by.
