---
"@kindgi/api": patch
---

**`passRate` counts what each case expects.** Each part of a frozen case's graded `expect`, its decisions and its answer, is one check in a comparison's `passRate`, of weight 1, beside the case's items. The recorded run passes a part when people marked it `right`, and each repetition that ran passes it when the part passed on every repetition. So a test set of cases that expect only an answer, the usual shape of a correction, has a `passRate` instead of `null`, and its `n` counts them. A case with no entry (only `items`, or a part that couldn't be checked) adds no check. `caseCoverage` and `weightedPrecisionAtK` stay items only.

A case's entry in `corrections` has `parts`: whether its decisions and its answer each passed on every repetition. A case's answer is now checked on a repetition whose decisions failed too, since it's a check of its own, so a case whose decisions fail can cost up to one judging call per repetition.
