---
"@kindgi/api": patch
---

**`passRate` counts what each case expects.** A frozen case's graded `expect` (its one entry, under the case's id) is one check in a comparison's `passRate`, of weight 1, beside the case's items. The recorded run passes it when every part the case expects is `right`, and each repetition that ran passes it when the case passed. So a test set of cases that expect only an answer, the usual shape of a correction, has a `passRate` instead of `null`, and its `n` counts them. A case with no entry (only `items`, or a part that couldn't be checked) adds no check. `caseCoverage` and `weightedPrecisionAtK` stay items only.
