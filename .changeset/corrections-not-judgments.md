---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
"@kindgi/policy-contract": patch
"@kindgi/types": patch
---

**A judgment is now a correction, in the API, the clients, the CLI and the docs.** This is a breaking rename, and no old name is kept.

- **Routes.** `/v1/judgments` is `/v1/corrections`, and `/v1/judgments/{judgmentId}/unregister` is `/v1/corrections/{correctionId}/remove`. `/v1/eval-suites/{suiteId}/versions/from-judgments` is `/v1/eval-suites/{suiteId}/versions/from-corrections`. The retention domain `judgment` is `correction`, as in `POST /v1/retention/sweep/correction`.
- **Fields.**
  - `judgmentId` is `correctionId`, and `judgmentIds` is `correctionIds`.
  - A proposal's `evidence.judgmentIds` is `evidence.fixes`.
  - These counts are renamed: `judgmentCount` to `correctionCount`, `minJudgments` to `minCorrections`, `runsWithJudgments` to `runsWithCorrections`, and `anyJudgment` to `anyCorrection`.
  - A response's `judgments` is `corrections`.
  - A suite built from corrections has `source: 'corrections'`.
  - The improve schedule's `threshold.judges` and `threshold.judgments` are `threshold.correctors` and `threshold.corrections`.
- **Schemas and types.**
  - `Judgment` is `Correction`, and `JudgmentWithCopies` is `CorrectionWithCopies`.
  - The `{ calls, notCalled }` value that was called `Correction` is now `ExpectedDecisions`, and its grading result is `ExpectedDecisionsResult`.
  - `Judged*` names are `Corrected*`, and `UnregisterJudgmentResult` is `RemoveCorrectionResult`.
- **TypeScript client.** `client.judgments` is `client.corrections`, and `unregister` is `remove`.
- **CLI.** `kindgi judgments add|list|show|unregister` is `kindgi corrections add|list|show|remove`.
