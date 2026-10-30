---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
"@kindgi/policy-contract": patch
"@kindgi/types": patch
---

**Judge classes are now corrector groups, the judging queue is the expert queue, and judging rules are queue rules.** This is a breaking rename, and no old name is kept.

- **Routes.** `/v1/judge-classes` is `/v1/corrector-groups`, with `{correctorGroupId}` in its paths. `/v1/projects/{projectId}/judging-queue` is `/v1/projects/{projectId}/expert-queue`, and `/v1/projects/{projectId}/judging-rules` is `/v1/projects/{projectId}/queue-rules`; their sub-paths are the same. The retention domain `judge_class` is `corrector_group`.
- **Fields and values.**
  - `judgeClassId` is `correctorGroupId`, and `judgeClassIds` is `correctorGroupIds`.
  - A correction, a corrected item and a test case's item say `expert` where they said `restricted`.
  - `classWeights` is `groupWeights`, and its value `restricted-only` is `experts-only`.
  - A release gate's `onlyRestrictedClasses` is `onlyExpertGroups`, and its check is named `groupWeights.expertsOnly`.
  - The expert queue's state `judged` is `corrected`, as is a rule result's `judged` count. Progress `byClass` is `byGroup`, and `wantedClassIds` is `wantedGroupIds`.
- **Errors.** Codes starting `judge-class-` start `corrector-group-`, `judging-rule-` codes start `queue-rule-`, and other `judging-` codes start `expert-queue-`.
- **Schemas and types.** `JudgeClass*` names are `CorrectorGroup*`, `JudgingRule*` names are `QueueRule*`, and the judging queue's `Judging*` names are `ExpertQueue*`.
- **TypeScript client.** `client.judgeClasses` is `client.correctorGroups`, `client.projects.judgingQueue` is `client.projects.expertQueue`, and `client.projects.judgingRules` is `client.projects.queueRules`.
- **CLI.** `kindgi judge-classes` is `kindgi corrector-groups`, `kindgi judging-queue` is `kindgi expert-queue`, and `kindgi judging-rules` is `kindgi queue-rules`. `--class` is `--group`, `--clear-class` is `--clear-group`, and `--class-weights` is `--group-weights`.
- **Docs.** The judging reference page is now the expert queue reference, at `guides/evals/expert-queue-reference/`.
