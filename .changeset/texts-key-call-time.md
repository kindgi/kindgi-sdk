---
"@kindgi/api": patch
"@kindgi/connections-inmemory": patch
---

**A texts registration's account key is refused when it's read, and in a pack's `env`.** A name stored before a registration took it as its key is refused too, when the secret is read through the guard; a webhook trigger's signing secret and a pack's `env` are read through it here:
- `guardSecretKeys(binding, { providerKeys, connectionKeys }, user)` wraps a `SecretsBinding` so each read refuses a model provider's key, then a texts registration's account key, to `user` (`SecretKeys` is its second argument; either set may be left out). Only the registration reads its own key: a read as `'a connection app'` whose context says `caller: 'connections'` and that registration's `appId`. `getVersion` carries no context, so it refuses the key to every user. Nothing is cached, so a key that a registration takes after a secret was written is refused at the next read. `guardProviderKeys` is `guardSecretKeys` with provider keys only.
- `SecretError` gains `connection-key-refused` (`name`, `appId`), and `ResolveContext` gains an optional `appId`, the reader's own say, which only that guard reads.
- `SecretUser` gains `"a pack's env"`. A pack's env never gets a held key: the name is left out as unreadable (`pack-env-secret-unreadable`, with code `connection-key-refused`) and the store isn't asked. A model provider's key in a pack's `env` is given as before.
- `POST /v1/deployments` answers `400 connection-key-refused` (`details.secret`, `details.appId`) when a name the pack's `env` declares is a live texts registration's account key: the first such name, its required names before its optional ones, checked after the tools' own issues. Nothing is registered.
- A webhook trigger whose signing secret is a held key answers `401` at its next delivery, and the receiver keeps that answer as long as it keeps a missing secret's.
- `ConnectionKeys` reads one key's holders: `holders(tenantId, name)`. `connectionKeysOf` uses the new optional `ConnectionBinding.keyHolders({ tenantId, name })`, a point read in `listApps` order, when the binding has it. Without it, every read lists all of the workspace's registrations, with no page cap, so a key held by a registration past the first pages is refused too. `refuseConnectionKeyNames(keys, tenantId, names, user)` is the write-time refusal over that read.
- `@kindgi/connections-inmemory` serves `keyHolders`. A removal kept while a number's inbound can't be put back still holds its key, and the removal frees it.
