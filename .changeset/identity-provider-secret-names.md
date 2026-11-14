---
"@kindgi/api": patch
---

An identity provider's secret references are checked as every other registration's are. `POST /v1/auth/providers` and `PATCH /v1/auth/providers/{providerId}` refuse a reference that names a model provider's key (`400 provider-key-refused`) or a name under the reserved `kindgi.` prefix (`400 reserved-name-prefix`), with the shared words and details, and nothing is registered or changed. A reference is checked by its secret's name, whatever its environment (`<name>` or `<env>/<name>`). A `PATCH` checks the whole merged provider, so a provider that already names such a secret is refused on any change until it names one of its own. `SecretUser` gains `'an identity provider'`, and `authRouter` takes the app's `providerKeys` (`createApp` passes them). `refuseSecretNames` is exported, for a reader that checks a name before it serves a value it keeps.
