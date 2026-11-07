---
"@kindgi/env-schema": patch
---

**`KINDGI_ACCOUNT_KEY`** (runtime 0.7.0 on): a self-hosted runtime's Kindgi account key, for the connections that sign in through Kindgi's own Meta app (Facebook Pages and Instagram). Optional, and a secret: set it by reference to a secret, pinned to a version. The server sends it to Kindgi only while an admin connects or disconnects one of those accounts, and nothing else calls Kindgi. Without it, Facebook Pages and Instagram show "Needs a Kindgi account", and everything else works as before. Kindgi Cloud deployments don't need it.
