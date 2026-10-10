---
"@kindgi/api": patch
---

Building a test set from judgments under a new suite id works with authorization on. `POST /v1/eval-suites/{suiteId}/versions/from-judgments` (`kindgi eval-suites from-judgments`) for a suite id never registered was refused for everyone, a tenant admin included (`403 permission-denied … can_admin on eval_suite:<id>`): the suite routes checked `admin` on the suite before the build, and a new suite has nothing to check yet. Under a new id, the build now needs `admin` on the project it names, the project the new suite belongs to. Under an existing suite, a tombstoned one included, the suite is checked first, as before, and so is anything else under a suite id.
