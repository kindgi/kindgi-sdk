---
"@kindgi/api": patch
"@kindgi/client": patch
---

A judge class's `assertableBy.principalIds` (the people and tokens it's restricted to) goes only to an admin on the class's scope. Any other reader of `GET /v1/judge-classes` and `GET /v1/judge-classes/{judgeClassId}` gets the class without it, and every reader gets the new `assertableBy.principalCount`: how many it names. The response's `assertableBy` is the new `JudgeClassAssertableByView` (TypeScript: `JudgeClassAssertableByView`); request bodies keep `JudgeClassAssertableBy`.
