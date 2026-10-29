---
"@kindgi/capabilities": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-azure-openai": patch
"@kindgi/adapter-model-bedrock": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/adapter-model-in-process": patch
"@kindgi/adapter-model-openai-compat": patch
---

**An `adapter_config` key the adapter doesn't take is refused at registration, naming it.** An `AdapterFactoryEntry` can declare the keys it takes: `configKeys`, `configKeyPrefixes` (openai-compat's `extraBody.<field>`) and `movedConfigKeys`, a key it doesn't read mapped to where its setting goes (Bedrock's `region` names `metadata.region`). `adapterConfigKeyProblems(entry, config)` in `@kindgi/capabilities` gives one problem per key the entry doesn't take, naming keys and places, never values. `POST /v1/providers` refuses a registration with any, as `provider-config-invalid`. `GET /v1/providers/{id}/check` lists them in a new optional `warnings` array, apart from `issues`, which still means the runtime can't build the provider; a stored registration with one builds without the key being read. `checked` is true when the adapter has a check or declares its keys. `kindgi doctor` reports a provider with only warnings as a warning, with the steps to register it again from its spec, never as "No usable provider". Every built-in adapter declares its keys; Anthropic and in-process take none. Azure OpenAI and Bedrock no longer refuse an unknown key in their own check, so a stored registration with one builds, where before the runtime skipped it. A custom adapter declares `configKeys`, and `movedConfigKeys` if it has any, to get the same; without `configKeys` an entry takes any key, as before.
