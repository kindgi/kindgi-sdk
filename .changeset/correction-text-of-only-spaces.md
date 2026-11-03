---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A correction's `shouldSay` or `why` of only spaces counts as not given, as an empty one does.** `POST /v1/corrections` and a hand-added test case (`POST /v1/agents/{agentId}/test-set/cases`) counted only an empty text as missing, so a text of only spaces was stored, and it could hide the other text from the answer checker. A text with any other character is stored as given, as before. Three answers change:
- A `shouldSay` or `why` of only spaces isn't stored. So `{ answer: "right", why: "  " }` is still a 201, but with no `why`.
- `{ answer: "wrong", shouldSay: "  " }`, with blank texts only, goes from a 201 to a 400: `answer: "wrong" needs shouldSay or why.`
- A `shouldSay` of only spaces without `answer: "wrong"` is no longer refused with `shouldSay goes with answer: "wrong".`, and isn't stored, as `""` isn't. That covers `{ answer: "right", shouldSay: "  " }`, and a body with `decisions` and no `answer`.
