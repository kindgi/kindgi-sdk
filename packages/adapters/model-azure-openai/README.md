# `@kindgi/adapter-model-azure-openai`

Azure OpenAI `ModelProvider` for [`@kindgi/capabilities`](../../capabilities/): a registration's models served by your Azure OpenAI deployments, on the v1 API, signed in with the resource's key or with the runtime's own Entra identity.

It covers **Azure OpenAI deployments**. Other models served by Azure AI Foundry (Llama, Mistral, DeepSeek…) aren't in it.

It's built on [`@kindgi/adapter-model-shared`](../model-shared/): the retries, typed errors (`ModelProviderError`), the reasoning state carried across a pause, usage and cost are the same as every adapter built on it. The requests are sent by the AI SDK's `@ai-sdk/azure` provider at the provider-spec level, pinned exactly.

## A registration

`adapter_id: @kindgi/adapter-model-azure-openai`, with these `adapter_config` keys:

| Key | What |
|---|---|
| `resourceName` | The Azure OpenAI resource, as in `<name>.openai.azure.com`. |
| `baseURL` | Instead of `resourceName`: a custom endpoint (`https://…/openai/v1`), such as a custom domain. |
| `deployments` | Required. The deployment serving each registered model: `"model=deployment,…"`, e.g. `"gpt-6.1-sol=gpt-6-1-sol,gpt-6-luna=luna-prod"`. Azure deployment names are yours to choose (often the model's own name, as `gpt-6.1-sol`), so every model in `metadata.models` needs one. |
| `api` | `responses` (default) or `chat-completions`. |
| `auth` | `api-key` (default): the resource's key, through `secret_ref`. `entra`: the runtime's Azure identity; no `secret_ref`. |

```json
{
  "adapter_id": "@kindgi/adapter-model-azure-openai",
  "adapter_config": {
    "resourceName": "acme-openai",
    "deployments": "gpt-6.1-sol=gpt-6-1-sol",
    "auth": "entra"
  },
  "metadata": {
    "id": "azure-openai",
    "region": "canadacentral",
    "models": [
      {
        "name": "gpt-6.1-sol",
        "contextWindow": 1050000,
        "sampling": false,
        "features": ["tool-use", "structured-output"],
        "cost": { "promptUsdPer1kTokens": 0.002, "completionUsdPer1kTokens": 0.01, "cachedPromptMultiplier": 0.05 }
      }
    ]
  }
}
```

`checkConfig` reports each problem with a registration at the setting at fault, without the network or the secret:
- `resourceName` and `baseURL` together, or neither;
- a `resourceName` that isn't one DNS label, or a `baseURL` that isn't https;
- an unknown `api`, `auth` or `adapter_config` key;
- `api-key` without `secret_ref`, or `entra` with one;
- a malformed `deployments` entry, a model the registration doesn't list, a deployment name Azure wouldn't take, or a model with no deployment.

## How it signs in

Each of these has a test:
- **`auth: entra`:** a bearer token from the runtime's Azure identity (`AdapterFactoryInput.identities.azure`) for the `https://cognitiveservices.azure.com/.default` scope, fetched for every request (the identity caches and renews it). No `api-key` header is sent. A runtime with no Azure identity refuses the registration, naming `KINDGI_AZURE_CLIENT_ID`. The identity needs the **Cognitive Services OpenAI User** role on the resource.
- **`auth: api-key`:** the key `secret_ref` names, read for every request and sent as `api-key`, so a rotated key takes effect on the next call.
- **Never the environment:** `AZURE_API_KEY` and `AZURE_RESOURCE_NAME` are never read. The provider is always given its endpoint and its credential.

## What it sends

- **Responses** (the default): `POST …/openai/v1/responses?api-version=v1`, with the deployment as `model` and `store: false`, so Azure keeps no conversation state for it: Kindgi's journal is the record.
- **Chat Completions:** `POST …/openai/v1/chat/completions`, with the deployment as `model`.
- Every attempt goes through the runtime's `fetch` (`AdapterFactoryInput.fetch`), which refuses the hosts its deployment forbids.

## Cost

`costUsd` is `tokenCostUsd` over the model's registered rates: prompt and completion, cached prompt tokens at `cachedPromptMultiplier`, and the long-context tier when registered. Azure's prices depend on the deployment type (Global, Data Zone, Regional), so register the rates of yours. Costs are estimates from published prices; Azure's invoice is authoritative.

## Exports

- **`azureOpenAIAdapterEntry`**: the `AdapterFactoryEntry` a runtime registers, with `azureOpenAIAdapterFactory` and `azureOpenAICheckConfig`.
- `readAzureOpenAIConfig(input)`: a registration read and checked, or every problem with it.
- `AZURE_OPENAI_ADAPTER_ID`, `AZURE_OPENAI_APIS`, `AZURE_OPENAI_AUTHS`, `AZURE_OPENAI_SCOPE`, and the `AzureOpenAIConfig`, `AzureOpenAIApi` and `AzureOpenAIAuth` types.

## License

Apache-2.0
