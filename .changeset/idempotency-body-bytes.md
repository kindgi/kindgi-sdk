---
"@kindgi/api": patch
---

Idempotency fingerprints a request by its body's bytes as they came, the same way for every caller.

- Fixed: a request from an API key limited to a project, sent again with the same `Idempotency-Key` and a different body, is refused with `409 idempotency-key-body-mismatch`, as it is for any other caller. Before, it got the first answer back.
- Fixed: a binary upload sent with an `Idempotency-Key` is stored as sent.
- Two bodies that differ only in bytes their text would lose (a byte-order mark, invalid UTF-8) are different bodies.
