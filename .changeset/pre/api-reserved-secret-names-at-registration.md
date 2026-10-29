---
"@kindgi/api": patch
---

**A registration that names a secret under the reserved `kindgi.` prefix is refused when it's made.** Those names are Kindgi's own, and the runtime never hands one out, so such a registration would only fail on every call. It's now a `400 reserved-name-prefix`, with the name in `details.secret`, wherever a model provider's key is already refused:
- **A tool**, published or reinstated, that declares one (`needsSpec.secrets`) or sends one (an HTTP spec's `authorization.secretRef`). A deployment that brings such a tool is refused with an issue at `/secrets/<name>`, as for a provider's key.
- **An MCP endpoint's** `secretRef` or auth secret, a **webhook endpoint's** `secretRef`, a **webhook trigger's** `hmacSecretName`, and a **connection app's** secrets, when made or changed.
- **A model provider's** `secret_ref` is refused as `bad-input`.

Nothing is stored when a registration is refused.
