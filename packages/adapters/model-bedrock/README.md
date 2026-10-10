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
| `adapter_config.baseURL` | Optional: another `bedrock-runtime` endpoint (https, its root), such as a VPC endpoint or a FIPS endpoint. With `aws-identity`, Bedrock's runtime in the region only (below); with `api-key`, any host and path (a gateway). Default: the region's own (`https://bedrock-runtime.<region>.amazonaws.com`, or its partition's domain). |

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
- a `baseURL` that isn't https, holds credentials, a query or a fragment, or has a path on Bedrock's own host;
- `aws-identity` with a `baseURL` that isn't Bedrock's runtime in the region, naming the host;
- `api-key` without `secret_ref`, or `aws-identity` with one.

## How it signs in

Each of these has a test. It signs in before each attempt, with the call's abort signal, and the attempt's request carries what that sign-in got, so calls running at once never share credentials and each attempt asks the identity once.
- **`auth: aws-identity`:** SigV4, with credentials from the runtime's AWS identity (`AdapterFactoryInput.identities.aws`), asked for every attempt, within 10 seconds; a call stopped meanwhile ends at once, with its own reason. The identity refreshes them itself, so short-lived role credentials renew. A runtime with no AWS identity refuses the registration when it registers, naming `KINDGI_AWS_IDENTITY`.
  - **Only Bedrock's runtime in the region gets them:** `bedrock-runtime.<region>`, `bedrock-runtime-fips.<region>`, or an interface VPC endpoint's own name (`vpce-….bedrock-runtime.<region>.vpce`), in the region's partition. A signed request carries the session token, so another host is refused at registration (and by the factory), naming it. A VPC endpoint with private DNS needs no `baseURL` at all. AWS lists the endpoints on [Amazon Bedrock endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/bedrock.html) and [interface VPC endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html).
  - **Its policy:** `bedrock:InvokeModel` on each model. For an inference profile, on the profile and on the foundation model in each Region the profile routes to; AWS shows these policies, a global profile's included, on [Prerequisites for inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html). The account also needs access to the model in the region.
- **`auth: api-key`:** the key `secret_ref` names, read for every attempt and sent as the bearer token (whitespace around it dropped), so a rotated key takes effect on the next call. No AWS credentials are looked for.
- **A failed sign-in** (the identity gives no credentials, the key can't be read, even with the secret store down, or is empty or blank) ends the call as an `auth` error at once, never retried.
- **A 403 from Bedrock says what to check**, for how it signed in: the identity's policy or the IAM user's the key belongs to, the account's access to the model, or expired credentials or an expired or revoked key.
- **No request follows a redirect** (`redirect: 'error'`): the credentials reach the endpoint and nothing else.
- **Never the environment:** `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` and `AWS_ENDPOINT_URL` are never read. The provider is always given its region, its endpoint and its credentials.

## What it sends

`POST <endpoint>/model/<model id>/converse`, through the runtime's `fetch` (`AdapterFactoryInput.fetch`), which refuses the hosts its deployment forbids. Bedrock's request id (`x-amzn-requestid`) is the result's `providerRequestId`. Running out of context (`model_context_window_exceeded`) is the finish reason `length`.

**Model ids:** a model id or a system inference profile (`us.amazon.nova-pro-v1:0`). Application inference profiles (`…:application-inference-profile/…`) aren't supported yet: the Claude handling and the Nova clean-up go by the model's name, so one would get neither.

## Nova's chain of thought

When tools are in play, Amazon Nova writes its reasoning into the answer: `<thinking>…</thinking>` before the reply. A Kindgi answer carries no reasoning (the other vendors keep it apart, and a result has no slot for reasoning text). So for a Nova model, one leading `<thinking>` block is taken out of the answer, and the result carries the warning `reasoning-text-removed` (`NOVA_THINKING_REMOVED`), which the model-call record keeps. Only an exact, closed, leading block is touched: one later in the text, or an unclosed one, is left as it came. Other vendors' models are never changed.

## Prompt caching

Bedrock caches only the prompt prefixes a request marks with a cache point, so the adapter marks them for a model whose registration prices cache reads (a positive `cachedPromptMultiplier` or `promptCacheReadMultiplier`) and that is Anthropic's Claude or Amazon Nova:
- after the system prompt (the first system message). The tools come before it, so the cached prefix holds them too;
- after the last message, when the call will be sent again: it has tools (the next step of a tool loop sends everything again) or an earlier answer (the next turn does).

That's two cache points at most, under Bedrock's four per request, each with the 5-minute cache. A prefix shorter than the model's minimum isn't cached and costs nothing extra. Other models, OpenAI's on Bedrock or an application inference profile among them, get no cache points. Nova's cache can take a few seconds to become readable: a call right after the first may write the prefix again, which costs nothing on Nova.

## Cost

`costUsd` is `tokenCostUsd` over the model's registered rates: prompt and completion, cache reads and writes at the model's `cachedPromptMultiplier` / `promptCacheCreationMultiplier` (the prompt rate when absent), and the long-context tier when registered. Bedrock's prices differ by model, region and tier, so register the rates of yours. Costs are estimates from published prices; AWS's invoice is authoritative.

## Exports

- **`bedrockAdapterEntry`**: the `AdapterFactoryEntry` a runtime registers, with `bedrockAdapterFactory` and `bedrockCheckConfig`.
- `readBedrockConfig(input)`: a registration read and checked, or every problem with it.
- `bedrockRuntimeEndpoint(region)`: a region's own `bedrock-runtime` endpoint; `partitionDnsSuffix(region)`; `isBedrockRuntimeHost(hostname, region)`: whether a host may get the runtime's credentials.
- `IDENTITY_TIMEOUT_MS`: how long the runtime's AWS identity may take.
- `isNovaModel(name)`, `withoutLeadingThinking(result)` and `NOVA_THINKING_REMOVED`: the Nova rule above.
- `BEDROCK_ADAPTER_ID`, `BEDROCK_AUTHS`, and the `BedrockConfig` and `BedrockAuth` types.

## License

Apache-2.0
