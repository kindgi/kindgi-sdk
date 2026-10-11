---
"@kindgi/sdk": patch
---

**Python: `kindgi[verify]` now requires cryptography 50.0.0 or later,** which fixes GHSA-537c-gmf6-5ccf, CVE-2026-69249, CVE-2026-69248 and CVE-2026-69247. It no longer caps the version (the old `<47` held apps below every one of those fixes), so apps can upgrade freely. Signed-export verification (`kindgi.exports`: Ed25519 and ECDSA verify, PEM public keys) works unchanged; CI tests it at the floor (50.0.0) and at the newest release.
