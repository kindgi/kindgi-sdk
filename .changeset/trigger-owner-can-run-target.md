---
"@kindgi/api": patch
"@kindgi/authz": patch
"@kindgi/cli": patch
---

**A trigger can't be set to run as an owner that can't run what it starts.** With an authorization store, the check every fire makes is now also made when the owner or the target is set: `execute` on the agent or flow, or `publish` on the agent for an improvement schedule.
- Registering a schedule, webhook or mail trigger, or taking one over, with `runAsServiceAccountId` (`--run-as`): an account that can't is refused with `409 trigger-owner-cannot-run-target`, and nothing is registered or changed. The message names the account and the target, and what fixes it: give the account the editor role on the target's project, or name another account. Only a caller who may name the account (`act_as`, a tenant admin's) gets this far.
- Running one as the project (`runAsProject`, `--run-as=project`), on create or take-over: the project's own account runs only what the project's editors can, so a target it can't run, such as one another project serves, is refused with the same 409. Its message says what fixes it: run the trigger as a service account that can, or own it yourself. The account is made before the check, so it stays, with no keys, for the next `runAsProject`.
- Changing a schedule's or mail trigger's target (another agent or flow, or for a schedule an Improve pass): the trigger keeps its owner, so the owner, a service account or a person, must be able to run the new target. Otherwise the change is refused with the same 409, naming the owner (or, for the project's own account, saying a project admin can take the trigger over first), and nothing changes. It isn't checked when the caller is the owner, whose own check has run, nor for an owner that was unregistered or removed: every fire is refused for that already, and a take-over is the fix.
- Before, the change was accepted, and then every fire was refused ("may no longer run") until the trigger paused.
- Without an authorization store, nothing changes: a grant limits nothing there.

`@kindgi/authz` exports `targetAccess(target)`: the action and resource a trigger's target is checked by.
