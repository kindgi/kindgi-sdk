---
"@kindgi/memory": patch
---

Memory retention and erasure (T273 M-5), first part: a log entry says how its hash was made. `LogEntry.hashVersion` is `2` for entries whose hash covers the payload's hash (`contentHash`), so an erasure can clear a payload and the chain still verifies; `payloadErasedAt` says when one was cleared. A v2 entry's `contentHash` is salted (`payloadSalt`, cleared with the payload), so the hash can't confirm a guessed message. Entries from before are `1` (absent).
