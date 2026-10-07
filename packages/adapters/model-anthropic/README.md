# `@kindgi/adapter-model-anthropic`

Anthropic `ModelProvider` for [`@kindgi/capabilities`](../../capabilities/). Wraps the official `@anthropic-ai/sdk` client behind the framework's provider-neutral interface and calls the Anthropic Messages API. One provider exposes every model listed in its `metadata.models[]`; `ModelCallInput.model` picks the model per call.

## Purpose

Translate between the framework's `ModelCallInput` / `ModelCallResult` and a non-streaming `messages.create` call:

- `system` messages are lifted into the top-level `system` parameter (several are joined with a blank line). `tool` messages become `tool_result` blocks folded into user turns, and assistant `toolCalls` become `tool_use` blocks.
- Tool names are encoded `.` → `__` on send and decoded on receive, because the Messages API rejects dots in tool names (`acme.orders.lookup` ↔ `acme__orders__lookup`). Tool ids must not contain a literal `__`.
- `max_tokens` is always sent, since Anthropic requires it: `input.maxOutputTokens`, else the model's `ModelInfo.maxOutputTokens`, else `4096`. `temperature` is sent when set, and `abortSignal` is passed to the request.
- `stop_reason` maps `end_turn` / `stop_sequence` / `pause_turn` → `stop`, `max_tokens` → `length`, `tool_use` → `tool-use`, `refusal` → `content-filter`, anything else → `stop`.
- Cost accounting that includes prompt caching. Anthropic reports four counters (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), and `costUsd` bills each at its own rate:
  `(input × rate + cacheCreation × rate × creationMultiplier + cacheRead × rate × readMultiplier + output × outputRate) / 1000`.
  The multiplier defaults match the 5-minute cache tier (creation `1.25`, read `0.1`); set `promptCacheCreationMultiplier: 2` in a model's `cost` for the 1-hour tier. `usage.promptTokens` includes cache writes and reads; `usage.cachedTokens` reports the cache reads when there are any.

## Exports

- **`anthropicAdapterEntry`** (`ANTHROPIC_ADAPTER_ID`) — the `AdapterFactoryEntry` a runtime registers. **`anthropicAdapterFactory`** builds the provider from a registration whose `secret_ref` names its Anthropic API key (resolved on every call); without one it throws, and **`anthropicCheckConfig(input)`** reports the same problem (`secret_ref`) without building anything.
- **`createAnthropicProvider(options)`** — returns a `ModelProvider` whose `metadata` is `options.metadata`. `invoke()` throws when `input.model` is not one of `metadata.models[].name`.
- **`AnthropicProviderOptions`**:
  - `apiKey: string | (() => string | Promise<string>)` — a static key, or a resolver called on every `invoke()`. The SDK client is cached and rebuilt only when the resolved key changes, so a rotated secret takes effect on the next call. A per-tenant registry can register one provider per tenant whose resolver reads that tenant's secret.
  - `metadata` — `ProviderMetadata` whose `models[]` are `AnthropicModelInfo`. Caller-supplied, because the API does not report pricing, context windows or features.
  - `baseURL?` — override the API host (proxy, gateway, region routing).
  - `clientOptions?` — other `@anthropic-ai/sdk` client options (`timeout`, `maxRetries`, `defaultHeaders`, `fetch`, …); `apiKey` and `baseURL` are excluded.
  - `client?` — an injected SDK client, used as-is; `apiKey`, `baseURL` and `clientOptions` are then ignored. Useful in tests.
- **`AnthropicModelInfo`** — `ModelInfo` whose `cost` also accepts `promptCacheCreationMultiplier?` and `promptCacheReadMultiplier?`.
- **Cost helpers** — `computeCostUsd(usage, rates)`, `toFrameworkUsage(usage)`, `CostRates`, `DEFAULT_CACHE_CREATION_MULTIPLIER_5MIN` (`1.25`), `DEFAULT_CACHE_READ_MULTIPLIER` (`0.1`).
- **Translation helpers** — `toAnthropicMessages(messages)`, `toAnthropicTools(tools)`, `fromAnthropicResponse(response)`, `mapStopReason(reason)`.
- **`ModelProvider`** — type re-export from `@kindgi/capabilities`.

## Example

```ts
import { createProviderRegistry } from '@kindgi/capabilities';
import { createAnthropicProvider } from '@kindgi/adapter-model-anthropic';

const anthropic = createAnthropicProvider({
  // Resolved on every call; `readTenantSecret` stands for your secret store lookup.
  apiKey: () => readTenantSecret(tenantId, 'anthropic-api-key'),
  metadata: {
    id: 'anthropic',
    region: 'us-east-1',
    models: [
      {
        name: 'claude-opus-4-7',
        contextWindow: 200_000,
        features: ['tool-use'],
        maxOutputTokens: 8_192,
        // Rates from the provider's published pricing; cache multipliers default to the 5-minute tier.
        cost: { promptUsdPer1kTokens: 0.005, completionUsdPer1kTokens: 0.025 },
      },
    ],
  },
});

const { registry } = createProviderRegistry();
registry.register(tenantId, anthropic);

const result = await anthropic.invoke({
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: 'You are the acme support assistant.' },
    { role: 'user', content: 'Summarise order 1042 in one sentence.' },
  ],
  maxOutputTokens: 256,
});
console.log(result.message.content, result.usage, result.costUsd);
```

A single-key deployment passes `apiKey: process.env.ANTHROPIC_API_KEY` (checked for `undefined` first) instead of a resolver.

## Non-goals

- **Streaming.** `invoke()` resolves with the complete response; streaming would need a different `ModelProvider` interface.
- **Extended thinking.** `ModelMessage` has no thinking field; `thinking` blocks in responses are dropped.
- **Image inputs.** `ModelMessage` content is text only.
- **Structured output.** `structuredOutput` on `ModelCallInput` is ignored.
- **Retry logic in the adapter.** Retries and timeouts are the SDK client's (`clientOptions.maxRetries`, `clientOptions.timeout`).

## Related

- [`@kindgi/capabilities`](../../capabilities/) — `ModelProvider`, `ProviderMetadata`, and the provider registry.
- [`@kindgi/adapter-model-openai-compat`](../model-openai-compat/) — the same interface for OpenAI-compatible endpoints.
- [`@kindgi/adapter-model-in-process`](../model-in-process/) — local models inside the Node.js process.
