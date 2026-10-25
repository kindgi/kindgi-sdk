---
"@kindgi/sdk": patch
"@kindgi/cli": patch
---

**A new authoring skill, "Fix what the experts corrected", with a guide to match.** When an expert judges an agent's run wrong and says why, a coding agent can now turn those corrections into changes. `kindgi init` and `kindgi skills sync` install the `kindgi-fix-corrections` skill (every language), which pulls an agent's "no" judgments (`kindgi judgments list --verdict=no`), reads each with the run behind it (`kindgi runs get`, `kindgi runs journal`), and sorts each correction to where it belongs — a rule in a tool's code, a setting, an approval rule, or the agent's instructions — adding a pack test per correction, then publishing a new version (`kindgi agents derive` for a setting, `kindgi deploy` for code) and asking a person to make it live with `kindgi agents promote … --reason`, naming the corrections. It never raises a limit or drops a check — a correction that would loosen anything goes to the owner — and it keeps the pulled runs' customer data out of the pack. The guide "Fix what the experts corrected" walks a person through the same loop.
