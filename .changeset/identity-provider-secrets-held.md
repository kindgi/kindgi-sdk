---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**An identity provider's secret is sign-in's only.** An OIDC client secret, or a SAML signing or decryption key, that a tenant's identity provider references is refused to every other user of the secrets store, when it's named and when it's read:
- A tool (declared or sent), an MCP endpoint, a webhook endpoint, a webhook trigger, a model provider, a connection app registration or a pack's `env` that names one answers `400 identity-provider-key-refused` (`details.secret`, `details.identityProviderId`), and nothing is stored. A name is checked whatever its environment, as a model provider's key is. The check runs after the reserved names, the model providers' keys and the texts registrations' keys. If one app registration serves both sign-in and a connection, give it a second client secret, stored under its own name.
- `IdentityProviderKeys` (`of(tenantId)`: each secret's name to the provider that references it) and `identityProviderKeysOf(binding)` read them from the `IdentityProviderBinding`. `identityProviderSecretNames(config)` names a provider's references, and `identityProviderKeyRefusal` and `refuseIdentityProviderKeyNames` are exported with them.
- `refuseSecretNames` takes the identity provider keys as an optional sixth argument, and every write route takes them as `identityProviderKeys` (`createApp` passes them).
- `SecretKeys` gains `identityProviderKeys`: `guardSecretKeys` refuses such a secret to every user but `'an identity provider'`. `SecretError` gains `identity-provider-key-refused` (`name`, `identityProviderId`).
- `POST /v1/auth/providers` and `PATCH /v1/auth/providers/{providerId}` also refuse a texts registration's account key (`400 connection-key-refused`). `authRouter` takes the app's `connectionKeys`.
- `@kindgi/client` reads `identity-provider-key-refused` as an invalid request, with `secret` and `identityProviderId` in `fields`. The CLI's `--client-secret-ref` help for `kindgi sso providers` and `kindgi connection-apps add` says to give each its own client secret.
