---
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/specs": patch
---

**Audit bundles made by Kindgi 0.1.4 verify.** 0.1.4 stamped an audit bundle's envelope `exportedAt` separately from the signed one, so about 1 in 10 came out a millisecond apart, and the new verifiers refused them. For that format only (the envelope's `bundleSchemaVersion` is the integer `1`, over a signed `bundleVersion: 1`), `verifySignedExport`, the Python SDK's `verify_signed_export` and `kindgi exports verify` no longer compare the envelope's unsigned `exportedAt`. They report the signed time in a new `notes` field: `made by Kindgi 0.1.4, which stamped the envelope's exportedAt separately: the signed export time is … (the envelope says …)`. Every later bundle keeps the strict check. Real 0.1.4 exports are a shared test vector in `@kindgi/specs` (`test-vectors/signed-export/kindgi-0.1.4.json`).
