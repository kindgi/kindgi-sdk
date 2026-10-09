---
"@kindgi/adapter-model-azure-openai": patch
"@kindgi/adapter-model-shared": patch
"@kindgi/capabilities": patch
---

**New package: `@kindgi/adapter-model-azure-openai`,** your Azure OpenAI deployments as a model provider, on the v1 API (Responses by default, or Chat Completions). It's built on `@kindgi/adapter-model-shared`.
- **A registration** names the resource (`adapter_config.resourceName`, or `baseURL` for a custom endpoint) and the deployment serving each model (`adapter_config.deployments`, `"model=deployment,…"`). Its `checkConfig` refuses a registration the factory couldn't build, naming the setting.
- **It signs in two ways:**
  - `auth: api-key` (default): the key `secret_ref` names, read for every request;
  - `auth: entra`: the runtime's own Azure identity, a bearer token per request, no key.
  It never reads `AZURE_API_KEY` or `AZURE_RESOURCE_NAME` from the environment.
- **Nothing kept on Azure's side:** Responses calls send `store: false`.
- **`AdapterFactoryInput.identities?`** (optional, `@kindgi/capabilities`) is the runtime's cloud identities for an adapter that signs in as the server: `azure` (`AzureTokenClient`, which an `@azure/identity` credential satisfies) and `aws` (`AwsCredentialClient`, a refreshing credential provider). The runtime fills each only from settings that name it, never from ambient credentials.
- **`createAdapterFactoryRegistry(seed, { identities })`** hands those to every factory and tells every `checkConfig` which are there (`AdapterConfigCheckInput.identities?`, also new). So a registration that signs in as an identity the runtime lacks (`auth: entra` with no Azure identity) is refused when it registers, naming the setting, rather than failing when it's first used.
- **`createAiSdkModelProvider`'s `fetch?`** (`@kindgi/adapter-model-shared/ai-sdk`) is the fetch every attempt goes through: the runtime's, which refuses the hosts its deployment forbids.
