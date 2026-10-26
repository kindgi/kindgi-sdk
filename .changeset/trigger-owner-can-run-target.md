---
"@kindgi/api": patch
"@kindgi/authz": patch
"@kindgi/cli": patch
---

**A trigger can't be set to run as an owner that can't run what it starts.** With an authorization store, the check every fire makes is now also made when the owner or the target is set: `execute` on the agent or flow, or `publish` on the agent for an improvement schedule.
- Registering a schedule, webhook or mail trigger, or taking one over, with `runAsServiceAccountId` (`--run-as`): an account that can't is refused with `409 trigger-owner-cannot-run-target`, and nothing is registered or changed. The message names the account and the target, and what fixes it: give the account the editor role on the target's project, or name another account. Only a caller who may name the account (`act_as`, a tenant admin's) gets this far.
- Changing a schedule's or mail trigger's target (another agent or flow, or for a schedule an Improve pass): the trigger keeps its owner, so the owner, a service account or a person, must be able to run the new target. Otherwise the change is refused with the same 409, naming the owner, and nothing changes. It isn't checked when the caller is the owner, whose own check has run, nor for an owner that was unregistered or removed: every fire is refused for that already, and a take-over is the fix.
- Before, the change was accepted, and then every fire was refused ("may no longer run") until the trigger paused.
- Without an authorization store, nothing changes: a grant limits nothing there.

`@kindgi/authz` exports `targetAccess(target)`: the action and resource a trigger's target is checked by.
