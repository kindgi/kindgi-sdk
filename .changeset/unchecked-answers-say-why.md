---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**A comparison says why a case's answer wasn't checked, and the returns sample names the model that judges it.**

- **`unchecked`, on a case and on the summary.** A case whose `expect` couldn't be graded has no entry in `corrections`, and adds no check to `passRate`. Its result now says why in `unchecked`. That's the answer checker's own reason, such as a version whose model settings name no model to judge with, or why the checker wasn't asked: there's none, the candidate isn't an agent version, the test run was stopped first, or the recorded run's tool calls can't be read. The summary's `unchecked` counts those cases and lists their reasons, each once, at most five. So a `passRate` with no value says why. Both fields are optional, and an older server leaves them out. A host's checker shows its `reason` there, so it names no secret and quotes nothing of the case.
- **The returns sample names its model.** In `kindgi init --template=returns-helper`, `blocks/returns-model.json` names Anthropic's `claude-sonnet-5-5` as the model it prefers. That model also judges a changed answer against its correction, in Improve's comparisons, in a suggested change's check, and in the pin's test run. With no model named, no changed answer would be checked. Its schema lists `providerId` and `model`, and `temperature` isn't marked for Improve to tune, since that model takes none. So the README's Improve step needs no `--provider` or `--model`, and the README says how to use another provider.
- **Which model judges an Improve run.** It's the version the run starts from. The model a run names only writes its new wording. The comparison guide and the test-run contract said a run's model could judge too, and they don't now. The `kindgi-fix-corrections` skill says which model judges an answer, and what happens when the version names none.
