---
'@kindgi/env-schema': patch
'@kindgi/api': patch
'@kindgi/cli': patch
---

The `secret-manager` secrets backend's settings: `KINDGI_SECRETS_MANAGER` (`azure`, `gcp` or `vault`; `aws` is read from runtime 0.1.7) picks your own secret manager, with `KINDGI_SECRETS_AZURE_VAULT_URL` (checked by `parseAzureVaultUrl`), `KINDGI_SECRETS_GCP_PROJECT_ID` (and, from runtime 0.1.7, `KINDGI_SECRETS_AWS_REGION`). `kindgi env init --secrets-backend=secret-manager --secrets-manager=<name>` writes them, and `--kms` is now for the `postgres` backend only. The secret-provider interface gains optional `providerVersion` fields, so Kindgi numbers secret versions itself whatever ids the provider uses.
