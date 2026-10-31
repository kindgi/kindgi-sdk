---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**The skills teach the correcting loop, and `kindgi init --template=returns-helper` scaffolds a pack to try it on.**

- `kindgi-fix-corrections` is rewritten. It pulls the open corrections sorted to a developer, reads each one with its run, and sorts it to where the fix belongs. A setting or wording fix becomes a suggested change, checked on the agent's test set. A code fix goes through the repo with a pack test, and the correction is marked `being-fixed` with `kindgi corrections set --link=<the pull request's URL>`. A pin marks each correction that passes as Fixed. Pinning stays with a person, and a correction that would loosen a rule goes to the agent's owner.
- The authoring-agents skills (TypeScript, Python, Java and Scala) show how an agent takes its instructions from a prompt block and its settings from settings blocks. They also cover which keys Improve may tune (`x-kindgi-tunable`) and point to `kindgi-fix-corrections` for after the agent ships.
- `kindgi-using` names the console's Quality tabs and an agent's Test set, Suggested changes and Pinned versions pages.
- Every template's `AGENTS.md` names `kindgi-fix-corrections`.
- `kindgi init --template=returns-helper` scaffolds a returns helper: one agent, a find-order and a refund tool on sample orders, and three blocks. `tone` holds its instructions, `refund-rules` its return window, and `returns-model` its model settings. Its README walks through correcting a run and fixing it in the pack on `kindgi dev`, then running Improve, pinning its fix, and going back on a deployed runtime, since `kindgi dev` refuses suggested changes and Improve runs.
