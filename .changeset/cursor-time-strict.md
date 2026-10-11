---
"@kindgi/api": patch
---

A list `cursor` must now carry a time a server actually writes: Postgres `timestamptz` text, or an ISO 8601 time naming a real calendar time. Anything else gets `400 bad-input` on every list that pages by time: conversations, runs, approvals (including a bare time cursor from before) and API keys. Before this, the check used `Date.parse`, which accepts `"1"`, `"x 1"` and `"Oct 9"`, so a hand-made cursor got past it and reached the store. Cursors the API hands out are unaffected.
