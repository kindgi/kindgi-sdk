---
"@kindgi/api": patch
"@kindgi/authz": patch
"@kindgi/runtime": patch
---

**A trigger in a later environment runs on its own project's right, once that project runs what it starts.** With an environment order, an agent or flow promoted into a later environment is served by more than one project, and a trigger made there is now checked the way a run started there by hand is.
- Who may run its target: when the trigger's project serves the agent or flow, and so does another project, the right asked is on the trigger's project: `call` for an agent, `execute` for a flow. An improvement schedule of such an agent asks `write` on the project where the agent gets its new versions. Anything else is asked as before: `execute` on the agent or flow, or `publish` on the agent. The same rule is asked of the caller when a schedule, webhook or mail trigger is registered or its target changes, and of its owner when it's registered, taken over or retargeted.
- `409 trigger-owner-cannot-run-target` names that right ("can't run agent "x" in this project"), and its fix names the narrowest role that carries it: the caller role on this project for an agent, the executor role for a flow, or the editor role on the project where an improved agent gets its new versions. Otherwise its words are as before.
- What it runs: with a reference scope, an agent named with no version is asked about as any version its project runs (`ItemReference.anyVersion`). A project that runs no version of it yet, such as a later environment before the first build that ships it is promoted there, is refused with `400 reference-out-of-scope` at `/target`, and the message says to promote a build that ships it there, or to make the trigger in the project that makes it. An agent that doesn't exist gets the same answer. This is asked after the caller's `write` on the project and before the target's right, so a caller who can write the project gets the 400 that names the fix, not a 403.
- The project's own account (`runAsProject`) is unchanged: it runs only what the project's editors can.
- A mail trigger's `statusReason` gains `target-out-of-reach`: no version of what it runs runs in its project, until a build that ships one is promoted there. Polls go on and read nothing until then.

`@kindgi/api` exports `runAccess` and `servedQuestionsFrom` (with the `RunAccess` and `ServedQuestions` types), so a runtime asks the same rule at every fire, and `triggerTargetReference`. `@kindgi/authz`'s `targetAccess` is the item's own right, which `runAccess` falls back to.
