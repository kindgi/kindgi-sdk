---
'@kindgi/env-schema': patch
'@kindgi/cli': patch
---

Azure settings for the runtime: `KINDGI_SECRETS_BACKEND_KMS=azure` with `KINDGI_SECRETS_AZURE_KEY_ID` (an Azure Key Vault key wraps the postgres backend's DEKs), `KINDGI_IMAGE_REGISTRY_AUTH=azure` (Azure Container Registry with the server's managed identity), and `KINDGI_AZURE_CLIENT_ID` (which user-assigned identity the server uses). `parseAzureKeyId` checks the key's URL and refuses one pinned to a version. `kindgi env init --kms=azure` writes them.
