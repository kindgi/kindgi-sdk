---
"@kindgi/env-schema": patch
"@kindgi/api": patch
"@kindgi/cli": patch
---

Sign-in finds a person's identity provider by their email's domain only once that domain is verified for a tenant. A runtime that serves one tenant routes that tenant's domains, as before. One that serves several routes a domain only once its operator lists it in the new `KINDGI_AUTH_VERIFIED_DOMAINS` (`acme.com:<tenant>`). Otherwise a tenant could list another company's domain and catch its people. `kindgi sso providers test` says so when a domain isn't routed.
