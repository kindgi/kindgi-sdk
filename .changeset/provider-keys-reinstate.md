---
"@kindgi/api": patch
"@kindgi/client": patch
---

Reinstating a retired tool version that declares or sends a model provider's key is refused too: `POST /v1/tools/{toolId}/versions/{version}/reinstate` answers `400 provider-key-refused`, and the version stays retired. Both clients now classify `provider-key-refused` as an invalid request and `provider-key-in-use` as a conflict, and the TypeScript client's `InvalidRequestError` carries the server's details besides `issues` as `fields` (for `provider-key-refused`: `secret` and `providerId`).
