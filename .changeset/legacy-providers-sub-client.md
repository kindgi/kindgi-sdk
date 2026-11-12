---
"@kindgi/client": patch
---

**`client.capabilities.providers` is deprecated: use `client.providers`.** Its methods now call `client.providers`'s and answer as they do.

- **`list` and `get`** are typed as the provider the API sends, `Provider`, with its models under `models[]`. Before, they were typed with `model`, `contextWindow`, `features` and `cost` on the provider itself, which no API has sent, so those fields read `undefined`. `LegacyCapabilitiesProvider` stays, as a deprecated name for `Provider`.
- **`configure`** takes the API's register body, `RegisterProviderInput` (`{ metadata, adapter_id, … }`), as `client.providers.register` does. Before, it sent the flat `ProviderSpec`, which the API refuses with `400 bad-input`, so no call could succeed. `ProviderSpec` stays exported, deprecated.
- **`delete`** is `client.providers.unregister`. An unknown or already-unregistered id answers `not-found` with the resource kind `provider`. Its docs used to say an already-unregistered id answered `unregistered: true`.
- **`capabilitiesFor`, `enable` and `disable`** answer as before. `enable` and `disable` still throw `not-yet-wired`, since a provider has no enabled state.
- **To move:** `list` → `providers.list`, `get` → `providers.get`, `configure` → `providers.register`, `capabilitiesFor(id)` → `(await providers.capabilities(id)).data`, `delete` → `providers.unregister`.
