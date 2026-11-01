---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A test run counts each part of a case that was checked, even when another part couldn't be.** A case's `expect` used to drop out whole when one part couldn't be checked: decisions it had just graded, failures included, added nothing to `passRate`, the summary's `corrections` or a release gate. Now each part that was checked is one check in `passRate`, whatever happened to the other.

- **Its entry says what wasn't checked.** A case that expects decisions or an answer always has an entry in perCase `corrections`. Its `parts` names only the parts that were checked, and a new optional `unchecked` (`"decisions"`, `"answer"`) names the rest: an answer with no checker, one the checker answers `unchecked` (say the version has no model settings, or the call to the judging model failed), one a stopped test run never checked, or `decisions: right` on a recorded run whose tool calls can't be read. A case with a part unchecked doesn't pass, and no repetition counts as passed.
- **A case none of whose parts could be checked has an entry too**, with `parts: {}`, every part it expects in `unchecked`, `pass: false` and `repetitionsPassed: 0`. It adds no check. A case that expects only `items` still has no entry.
- **A known failure counts; an unknown pass doesn't.** An entry with a part unchecked and none failed is left out of the summary's `corrections`, and leaves its correction's status alone, as before. One whose checked part failed is in the summary's `corrections` as a fail, so `cases.noNewFailures` sees it. **And a `fixed` correction whose checked decisions failed beside an unchecked answer is now reopened**, where before it was left alone.
- **The summary says so.** A new optional summary `unchecked: { cases, why? }` counts the cases whose pass isn't known, the ones left out of `corrections`. `why` is the first reason the checker gave for an answer of theirs it couldn't check. A rescore keeps the entries of the run it rescores, and that run's reason. `AnswerCheck`'s `unchecked` `reason` is shown there, so it names what's missing and never quotes the case or its answer.
- **Judging cost.** With `decisions: right` and recorded calls that can't be read, the answer is now checked: at most one judging call per repetition, up to the first answer that fails.
- The TypeScript client's and the Python client's types gain the entry's `unchecked` and the summary's `unchecked`. Both are optional: an older server sends neither.
