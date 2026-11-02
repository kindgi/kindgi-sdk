---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**The `kindgi-using` skill, the returns-helper template and the CLI name the console's Corrections section, an agent's tabs and a run's page.**

- `kindgi-using` names **Corrections** (`corrections`) where it named Quality, and the `…/corrections` tab on an agent's and a flow's page.
- `kindgi-using` gives a run's console page under its agent or flow, `agents/<agentId>/runs/<runId>` or `flows/<flowId>/runs/<runId>`, with its tabs, and each agent's and flow's `…/runs`. `runs/<runId>`, with no tab, finds either.
- The returns-helper template's README names **Corrections** > **To fix**, and an agent's **Test set**, **Suggested changes** and **Pinned versions** tabs, where it named Quality and pages.
- `kindgi expert-queue` describes the project's To review list, where it said To correct.
- A pack keeps the skill copies it was made with until they're refreshed. Once the pack's `@kindgi/cli` is upgraded, `kindgi dev` refreshes each copy you haven't edited as it starts, and `kindgi skills sync` refreshes them any time (`./kindgiw dev` and `./kindgiw skills sync` in a Java or Scala pack). A copy you edited is kept, and `kindgi skills sync --force` replaces it. Until then, an older `kindgi-using` gives a run's tab as `runs/<runId>/cost` and the like, which the 0.4.0 console no longer opens.
