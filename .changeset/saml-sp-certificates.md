---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**A SAML provider carries the service provider's certificates, for its metadata.**
- `SamlProviderConfig`, and the API's SAML provider, take `spSigningCertificates` and `spDecryptionCertificates`: the certificates (PEM) of the keys `spSigningKeyRef` and `spDecryptionKeyRef` name. They're published in the service provider's metadata (`signIn.spMetadataUrl`), so an identity provider that imports it has them, and no one adds a certificate by hand. Several signing certificates let the key change without a gap. Certificates without their key are refused with `400 invalid-provider-config`, on a registration and on a change; `PATCH` removes them with `null`.
- `kindgi sso providers finish` and `update` take `--sp-signing-certificate=@<file>` and `--sp-decryption-certificate=@<file>`, each repeatable, and `--sp-decryption-key-ref=<name>` beside `--sp-signing-key-ref`.
