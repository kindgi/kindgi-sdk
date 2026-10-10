---
"@kindgi/api": patch
"@kindgi/compliance": patch
"@kindgi/crypto": patch
---

The deprecated export-signing inputs are gone. **Breaking, for code that embeds `@kindgi/api`:**
- `CreateAppInput.signingKey` is removed: pass `exportSigning`, an `ExportSigningBinding` (`createEd25519ExportSigner` or `createExportSignerFromPem` from `@kindgi/crypto`, or a KMS-backed binding).
- `exportSignerFromSigningKeyBinding` (`@kindgi/crypto`) is removed with it.
- `ComplianceEvidenceGenerator.exportSigned` is removed. `@kindgi/api` builds and signs a compliance export itself, so nothing called it.

The Kindgi runtime already passes `exportSigning`, and nothing changes for it or for the signed exports it serves.
