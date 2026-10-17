# `@kindgi/adapter-model-anthropic`

Anthropic `ModelProvider` for [`@kindgi/capabilities`](../../capabilities/). Wraps the official `@anthropic-ai/sdk` client behind the framework's provider-neutral interface and calls the Anthropic Messages API. One provider exposes every model listed in its `metadata.models[]`; `ModelCallInput.model` picks the model per call.

## Purpose

Translate between the framework's `ModelCallInput` / `ModelCallResult` and a non-streaming `messages.create` call:

- `system` messages are lifted into the top-level `system` parameter, each its own text block, in order. `tool` messages become `tool_result` blocks folded into user turns, and assistant `toolCalls` become `tool_use` blocks.
- Tool names are encoded `.` → `__` on send and decoded on receive, because the Messages API rejects dots in tool names (`acme.orders.lookup` ↔ `acme__orders__lookup`). Tool ids must not contain a literal `__`.
- `max_tokens` is always sent, since Anthropic requires it: `input.maxOutputTokens`, else the model's `ModelInfo.maxOutputTokens`, else `4096`. `temperature` is sent when set, and `abortSignal` is passed to the request.
- `stop_reason` maps `end_turn` / `stop_sequence` / `pause_turn` → `stop`, `max_tokens` → `length`, `tool_use` → `tool-use`, `refusal` → `content-filter`, anything else → `stop`.
- **Thinking goes back with the tool results.** The Messages API wants an answer's `thinking` and `redacted_thinking` blocks back, unchanged and in place, on the call that sends its tool results, and `ModelMessage` has no field for them. So an answer with thinking and tool calls keeps its content, in order, in its first tool call's `signature` (`anth1.`), and the next call to the same model sends it back while the message still has the same text and the same calls in the same order. Otherwise (another model, an edited message) the message goes back as its text and then its calls. The thinking text is kept as Anthropic's API returned it, encoded but not encrypted, so whoever can read the conversation or the turn's run can read it; only `redacted_thinking` comes encrypted.
- When a call reaches `max_tokens` after thinking and before any answer text, the answer is empty (a tool call the cap cut short isn't run), and the result carries a `thinking-used-max-tokens` warning naming the cap.
- Cost accounting that includes prompt caching. Anthropic reports four counters (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), and `costUsd` bills each at its own rate:
  `(input × rate + cacheCreation × rate × creationMultiplier + cacheRead × rate × readMultiplier + output × outputRate) / 1000`.
  The multiplier defaults match the 5-minute cache tier (creation `1.25`, read `0.1`). Claude Opus 5.5 and Sonnet 5.5 read at `0.05`: set `promptCacheReadMultiplier: 0.05` in their `cost` (the `anthropic` preset does). `usage.promptTokens` includes cache writes and reads; `usage.cacheReadTokens` and `usage.cacheWriteTokens` report them.
- **Prompt caching.** Anthropic caches only the prefixes a request marks with `cache_control`, so the adapter marks up to three (`withPromptCache`), each with the 5-minute cache:
  - the last tool (the tool definitions);
  - the first system block (the agent's prompt; later system blocks, such as retrieved context, change from turn to turn);
  - the last block of the last message, when another call will send this prefix again: the call has tools (the next step of a tool loop) or the conversation has an earlier answer (its next turn). A one-off call (no tools, no earlier answer, e.g. a judge) leaves its message unmarked: writing a tail that's never read again would only cost more.

  The next call in a turn then reads the prefix at the read rate and writes only what's new. A prefix shorter than the model's minimum (from 512 tokens on the Claude 5.5 models) isn't cached and costs nothing extra. How Anthropic keeps cached prompts, and their eligibility for zero data retention: Anthropic's [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) pages.

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
- **Translation helpers** — `toAnthropicMessages(messages, model?)`, `toAnthropicTools(tools)`, `fromAnthropicResponse(response, toolIdOf?, model?)`, `mapStopReason(reason)`. Given the model, they keep and send back an answer's thinking.
- **`THINKING_USED_MAX_TOKENS`** — the warning code `thinking-used-max-tokens`.
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
- **A thinking field.** `ModelMessage` has none: an answer's thinking is kept in a tool call's `signature` to be sent back, not as a field of its own.
- **Image inputs.** `ModelMessage` content is text only.
- **Structured output.** `structuredOutput` on `ModelCallInput` is ignored. No Kindgi caller sends it today: an agent's typed output is checked by parse and repair on every provider, so the anthropic preset's models still declare `structured-output` (they can follow a JSON schema natively).
- **Retry logic in the adapter.** Retries and timeouts are the SDK client's (`clientOptions.maxRetries`, `clientOptions.timeout`).

## Related

- [`@kindgi/capabilities`](../../capabilities/) — `ModelProvider`, `ProviderMetadata`, and the provider registry.
- [`@kindgi/adapter-model-openai-compat`](../model-openai-compat/) — the same interface for OpenAI-compatible endpoints.
- [`@kindgi/adapter-model-in-process`](../model-in-process/) — local models inside the Node.js process.
