---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A suggested change says how many corrections it fixes in all: `correctionCount`.** `fixes` names the first 100 at most, and an Improve run can fix more, so past 100 its length was not the count. `GET /v1/suggested-changes/{suggestedChangeId}`, the list and every other answer with a suggested change now carry `correctionCount`, as does `SuggestedChange` in `@kindgi/client`. The field is optional: an older runtime doesn't send it, and there `fixes.length` is the count.
