---
'@kindgi/env-schema': patch
---

`KINDGI_SECRETS_AWS_REGION`, `KINDGI_SECRETS_AWS_KMS_KEY_ID` and `KINDGI_SECRETS_MANAGER=aws` say they're used from runtime 0.1.7: runtime 0.1.6 refuses `KINDGI_SECRETS_MANAGER=aws` at startup.
