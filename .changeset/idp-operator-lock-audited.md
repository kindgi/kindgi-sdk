---
"@kindgi/api": patch
---

**A refused identity-provider change is in the access audit.** When the deployment's operator manages sign-in (`KINDGI_AUTH_TENANT_PROVIDERS=off`), a change to identity providers from a key without `kindgi:system` is still answered `403 identity-providers-operator-managed`, with the same message. It is now also recorded with the authorizer, like every other refusal the API decides itself, so the access audit (`GET /v1/audit/authz`) shows it. Its error gains the `action`, `resource` and `reason` details that the other refusals carry.
