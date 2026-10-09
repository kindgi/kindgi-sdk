---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

A test set can be narrowed to a segment. `POST /v1/eval-suites/{suiteId}/versions/from-judgments` takes `segments`, and `kindgi eval-suites from-judgments` takes a repeatable `--segment=key:value`. With it, the test set keeps only runs started in that segment path or below it, and its spec records the path.
- A judgment's copy of its run keeps the segment path the run was started with (`run.segments`; empty when there was none).
- A run judged before this change has no recorded segment, so it's left out of a narrowed test set.
