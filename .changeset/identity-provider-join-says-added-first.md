---
"@kindgi/api": patch
---

The API reference says an identity provider's `join: domain` lets no one in on its own. Its description said `domain` also let in anyone from the provider's `domains`, but sign-in doesn't use it: with either value, only people a tenant admin added get in. The field, its values and what a registration stores don't change.
