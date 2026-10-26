---
"@kindgi/cli": patch
---

**`kindgi deploy --dry-run` works on an unsigned envelope** (`kindgi build --skip-sign`). It shows the body it would POST, less `signerKeyId`, `signerPublicKey` and `signature`, which a signed build adds, and exits 0. Before, it warned that it was going ahead, then failed with "Internal error building POST body".
- **No Idempotency-Key** is shown, since the key hashes the signed body, unless you pass `--idempotency-key`.
- **In the summary on stdout,** `wouldPost` is that body, and `idempotencyKey` is left out unless you passed one.
- Without `--dry-run`, an unsigned envelope is refused as before.
