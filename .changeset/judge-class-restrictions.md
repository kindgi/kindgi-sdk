---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

A judge class can be restricted to some judges. `assertableBy` on `POST /v1/judge-classes` and `PATCH /v1/judge-classes/{judgeClassId}` (`null` on the PATCH lifts it) takes `minReviewerRole`, `principalKinds` and `principalIds`, and a caller must meet each one given. A judgment that names a restricted class its caller doesn't meet is `403 judge-class-not-allowed`, and the message says why. A judgment recorded under a restricted class carries `restricted: true`; adding or lifting a restriction later doesn't change it. A test set's items carry `restricted`: the yes and total weight of those judgments alone.

A comparison takes `classWeights`: `as-recorded` (the default, every judgment at its class's weight) or `restricted-only` (only judgments carrying `restricted` count; an item with none counts as unjudged). The summary records which one it used. A gate policy's spec takes `onlyRestrictedClasses`: the promotion's comparison must be `restricted-only` (check `classWeights.restrictedOnly`), so a class anyone may assert can't move the gate.

`@kindgi/api` exports `whyNotAssertable`, `JudgeClassAssertableBy`, `JudgeClassAsserter` and `EvalClassWeights`. The TypeScript client's judge-class types take `assertableBy`, and `evalRuns.start` takes `classWeights`. The Python client sends both (`assertable_by=None` lifts a restriction). The CLI's `judge-classes add` and `set` take `--min-reviewer-role`, `--principal-kind` and `--principal-id`, `set --unrestricted` lifts the restriction, and `eval-runs start` takes `--class-weights`.
