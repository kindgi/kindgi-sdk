---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/crypto": patch
"@kindgi/compliance": patch
"@kindgi/env-schema": patch
"@kindgi/specs": patch
---

**Signed exports work end to end: one export key, one envelope, and a verifier.** An approval's audit bundle, a run's provenance and compliance evidence are signed with the deployment's export key.

- **The key:** `createApp({ exportSigning })` takes an `ExportSigningBinding` (`@kindgi/crypto`: async, so a KMS can back it; `createEd25519ExportSigner` for a key file). Key ids are derived from the public key (`ex_…`). The old `signingKey` still works, deprecated. On the runtime: `KINDGI_EXPORT_SIGNING_KEY_PATH`, `KINDGI_EXPORT_SIGNING_KEY` (base64 PEM, for Secret Manager) or the optional `KINDGI_EXPORT_SIGNING_KMS_KEY`; `kindgi dev` passes a key file through, or the runtime makes one.
- **One envelope:** the signed bytes (`bundle`), the signature, the public key, an optional `kind`, and `exportedAt`, which is now signed and the same in the envelope. Body versions: the audit bundle is `2.0.0` (a string; it was the integer `1`), provenance `1.2.0` (adds the signed `exportedAt`), compliance `1.0.0`.
- **No body needed:** `signingKeyId` is optional (the active key), and an empty body reads as `{}`.
- **Each export is recorded** as an `export-signed` audit event (who, what, which key, the SHA-256 of the signed bytes). An export whose record can't be written isn't handed out.
- **`GET /v1/export-signing-keys`** lists the public keys to pin; `exportSigningKeys.list()` in the TS client.
- **Verify:** `verifySignedExport` in `@kindgi/client` (Web Crypto); `approvals.audit.verify`, `provenance.verify` and `compliance.evidence.verify` now work. Python: `kindgi.exports.verify_signed_export` (`pip install 'kindgi[verify]'`). CLI: `kindgi exports verify <file> [--trust=<pem>] [--from-runtime]`.
- **CLI:** `kindgi approvals export <approval-id>`; `kindgi provenance export`'s `--signing-key` is optional.
- **Compliance:** `collectEvidence` builds an export's records, so the generator's `exportSigned` is optional and deprecated.
- **Specs:** `signed-export.schema.json` (the envelope), and `audit-bundle.schema.json` 2.0.0 describes the bundle the API exports.
- **Cloud Run module:** `export_signing = "secret" | "kms"` (opt-in).
