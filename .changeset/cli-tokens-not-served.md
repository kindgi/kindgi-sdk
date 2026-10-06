---
"@kindgi/cli": patch
---

`kindgi tokens create` and `revoke` say why they aren't available instead of "not yet wired": the Kindgi runtime doesn't serve `/v1/tokens` yet, so it has no API keys to mint or revoke; it authenticates with the token it starts with (`KINDGI_API_TOKEN`, or the one `kindgi dev` prints).
