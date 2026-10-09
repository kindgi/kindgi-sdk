# `@kindgi/adapter-model-bedrock`

Amazon Bedrock `ModelProvider` for [`@kindgi/capabilities`](../../capabilities/): a registration's models on Bedrock's Converse API (Anthropic's Claude, Amazon Nova, Meta's Llama, Mistral, OpenAI's models and the others Bedrock serves), signed in as the runtime's own AWS identity or with a Bedrock API key.

It's built on [`@kindgi/adapter-model-shared`](../model-shared/): the retries, typed errors (`ModelProviderError`), the reasoning state carried across a pause, usage and cost are the same as every adapter built on it. The requests are sent by the AI SDK's `@ai-sdk/amazon-bedrock` provider at the provider-spec level, pinned exactly.

## A registration

`adapter_id: @kindgi/adapter-model-bedrock`:

| Setting | What |
|---|---|
| `metadata.region` | Required: the AWS region Bedrock runs in (`us-east-2`). The requests go to it and are signed for it. |
| `metadata.models[].name` | A Bedrock model id or inference-profile id, as Bedrock names it: `us.amazon.nova-pro-v1:0`, `us.anthropic.claude-sonnet-5-5`. A cross-region profile (`us.`, `eu.`, `apac.`…) is called from a region in its geography. |
| `adapter_config.auth` | `aws-identity` (default): the runtime's AWS identity, requests signed with SigV4. `api-key`: a Bedrock API key through `secret_ref`, sent as a bearer token. AWS recommends API keys for exploration only. |
| `adapter_config.baseURL` | Optional: a `bedrock-runtime` endpoint of your own (https), such as a VPC endpoint or a FIPS endpoint. Default: the region's own (`https://bedrock-runtime.<region>.amazonaws.com`, or its partition's domain). |

```json
{
  "adapter_id": "@kindgi/adapter-model-bedrock",
  "metadata": {
    "id": "bedrock",
    "region": "us-east-2",
    "models": [
      {
        "name": "us.amazon.nova-pro-v1:0",
        "contextWindow": 300000,
        "features": ["tool-use", "structured-output"],
        "cost": { "promptUsdPer1kTokens": 0.0008, "completionUsdPer1kTokens": 0.0032 }
      }
    ]
  }
}
```

`checkConfig` reports each problem with a registration at the setting at fault, without the network or the secret:
- a `metadata.region` that isn't an AWS region (`global`, `unspecified`);
- an unknown `auth` or `adapter_config` key;
- a `baseURL` that isn't https;
- `api-key` without `secret_ref`, or `aws-identity` with one.

## How it signs in

Each of these has a test:
- **`auth: aws-identity`:** SigV4, with credentials from the runtime's AWS identity (`AdapterFactoryInput.identities.aws`), asked for every request. The identity refreshes them itself, so short-lived role credentials renew. A runtime with no AWS identity refuses the registration when it registers, naming `KINDGI_AWS_IDENTITY`. The identity needs `bedrock:InvokeModel` on the models (and their inference profiles).
- **`auth: api-key`:** the key `secret_ref` names, read for every request and sent as the bearer token, so a rotated key takes effect on the next call. No AWS credentials are looked for.
- **Never the environment:** `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` and `AWS_ENDPOINT_URL` are never read. The provider is always given its region, its endpoint and its credentials.

## What it sends

`POST <endpoint>/model/<model id>/converse`, through the runtime's `fetch` (`AdapterFactoryInput.fetch`), which refuses the hosts its deployment forbids. Bedrock's request id (`x-amzn-requestid`) is the result's `providerRequestId`.

## Cost

`costUsd` is `tokenCostUsd` over the model's registered rates: prompt and completion, cache reads and writes at the model's `cachedPromptMultiplier` / `promptCacheCreationMultiplier` (the prompt rate when absent), and the long-context tier when registered. Bedrock's prices differ by model, region and tier, so register the rates of yours. Costs are estimates from published prices; AWS's invoice is authoritative.

## Exports

- **`bedrockAdapterEntry`**: the `AdapterFactoryEntry` a runtime registers, with `bedrockAdapterFactory` and `bedrockCheckConfig`.
- `readBedrockConfig(input)`: a registration read and checked, or every problem with it.
- `bedrockRuntimeEndpoint(region)`: a region's own `bedrock-runtime` endpoint.
- `BEDROCK_ADAPTER_ID`, `BEDROCK_AUTHS`, and the `BedrockConfig` and `BedrockAuth` types.

## License

Apache-2.0
