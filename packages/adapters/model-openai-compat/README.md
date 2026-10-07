# `@kindgi/adapter-model-openai-compat`

OpenAI-compatible `ModelProvider` for [`@kindgi/capabilities`](../../capabilities/). Wraps the official `openai` SDK client behind the framework's provider-neutral interface and works against OpenAI's own API and any endpoint that speaks the Chat Completions wire format — Ollama, vLLM, llama-server, LM Studio, OpenRouter, Groq, Together, Fireworks, DeepInfra, or a LiteLLM proxy. One adapter, many backends: `baseURL` selects the endpoint, and `api` the OpenAI API it speaks.

## Purpose

Translate between the framework's `ModelCallInput` / `ModelCallResult` and one non-streaming call, on one of two OpenAI APIs (`api`):

- **`'responses'`** — OpenAI's Responses API (`responses.create`), the default for a `baseURL` on `api.openai.com` (and its data-residency hosts, such as `eu.api.openai.com`). OpenAI's GPT-6 models call tools only through it.
- **`'chat-completions'`** — Chat Completions (`chat.completions.create`), the default for every other `baseURL`: the format the OpenAI-compatible servers speak.

### Chat Completions

- Messages map role for role. Assistant `toolCalls` become `tool_calls` with JSON-encoded arguments; `tool` messages carry `tool_call_id`.
- `tools` become `function` tools; `structuredOutput` becomes `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`; `temperature` and `maxOutputTokens` (as `max_tokens`) are sent only when set.
- Chat Completions endpoints reject `.` in function names, so tool names are encoded `.` → `__` on send and decoded on receive (`acme.orders.lookup` ↔ `acme__orders__lookup`). Tool ids must not contain a literal `__`. Tool-call arguments that are not valid JSON decode to `{}`.
- `finish_reason` maps `tool_calls` / `function_call` → `tool-use`, `content_filter` → `content-filter`, `length` → `length`, anything else → `stop`.
- `costUsd` is computed from the matching `ModelInfo.cost` (`computeCost`), on both APIs. The wire format carries no pricing, so rates come from the caller (`OpenAICompatCostRates`, the names the Gemini and Anthropic adapters price with):
  - prompt and completion tokens per 1K tokens (`promptUsdPer1kTokens`, `completionUsdPer1kTokens`);
  - cached prompt tokens at `cachedPromptMultiplier` of the prompt rate, and cache-write tokens at `promptCacheCreationMultiplier` (each absent: the prompt rate);
  - `longContext: { thresholdTokens, promptUsdPer1kTokens, completionUsdPer1kTokens }`: past the threshold (cached and cache-write prompt tokens included), the whole call bills at those rates, the cache multipliers applying to the long prompt rate;
  - `dataResidencyMultiplier`: an uplift on the whole call, only when `baseURL` is a data-residency host (`eu.api.openai.com`; `isDataResidencyHost`).
  A rate that isn't a finite, non-negative number is ignored. The `openai` preset carries OpenAI's GPT-6 rates.

### Responses

- **Stateless:** every call sends the whole conversation with `store: false`, so OpenAI keeps no conversation state for it (no `previous_response_id`).
- **Input items:** `system` messages go as `developer` messages, `user` and `assistant` as messages, assistant `toolCalls` as `function_call` items, and `tool` messages as `function_call_output` items.
- **Tools and typed output:** `tools` become flat `function` tools (`strict: false`, the same `.` → `__` name encoding); `structuredOutput` becomes `text.format: { type: 'json_schema', name, schema, strict: true }`; `temperature` and `maxOutputTokens` (as `max_output_tokens`) are sent only when set.
- **The answer:** its `output_text` (its refusal when it has no text) and its `function_call` items. `incomplete` maps `max_output_tokens` → `length` and `content_filter` → `content-filter`; a `failed` response throws, naming OpenAI's error code and message.
- **Reasoning between tool calls:** a reasoning model's reasoning items (encrypted by OpenAI), with the item ids and `phase` that tie them to the message and calls after them, are carried in the first tool call's `ModelToolCall.signature` (opaque, versioned `oair1.`). When the conversation continues with the same model, they go back in their original order; for any other model, or a signature that isn't this adapter's, the turn goes back without them. A final answer's `phase` isn't carried (`ModelMessage` has no signature).
- **Usage:** `input_tokens` / `output_tokens`, with the cached, cache-write and reasoning parts reported apart when given.

## Exports

- **`createOpenAICompatModelProvider(options)`** — returns a `ModelProvider` whose `metadata` is `options.metadata` unchanged. The SDK client is created on the first `invoke()` and reused while the key stays the same. `invoke()` throws when `input.model` is not one of `metadata.models[].name`, and passes the turn's `abortSignal` to the request, so a cancelled turn cancels the call.
- **`OpenAICompatProviderOptions`**:
  - `baseURL: string` — endpoint root, e.g. `BASE_URLS.OLLAMA_LOCAL`.
  - `apiKey: string | (() => string | Promise<string>)` — a static key, or a resolver called on every `invoke()`: a rotated key takes effect on the next call. Local runners that ignore keys still need a non-empty string such as `'unused'`.
  - `metadata: ProviderMetadata` — surfaced to the router. `models[]` must list every model invoked through this connection, with its per-1K-token cost.
  - `api?: 'responses' | 'chat-completions'` (`OPENAI_COMPAT_APIS`) — the OpenAI API to speak. Absent: `defaultOpenAICompatApi(baseURL)`, `'responses'` for `api.openai.com` and its subdomains, `'chat-completions'` for any other. Another value is refused at construction.
  - `clientOptions?` — other `openai` client options (`timeout`, `maxRetries`, `defaultHeaders`, `fetch`, …); `apiKey` and `baseURL` are excluded.
  - `extraBody?` — fields merged into every request body: settings an endpoint takes that the OpenAI format has no field for. A Qwen thinking model served by vLLM, SGLang or llama-server needs `{ chat_template_kwargs: { enable_thinking: false } }`, or its answer starts with its thinking and a typed (JSON) answer fails. The fields the adapter sets are refused: on Chat Completions `EXTRA_BODY_RESERVED` (`model`, `messages`, `tools`, `response_format`, `temperature`, `max_tokens`, `stream`), on Responses `EXTRA_BODY_RESERVED_RESPONSES` (`model`, `input`, `tools`, `text`, `temperature`, `max_output_tokens`, `stream`, `store`). On Responses, `{ reasoning: { effort: 'low' } }` sets a reasoning model's effort.
- **`openAICompatAdapterFactory`** (`OPENAI_COMPAT_ADAPTER_ID`) — the `AdapterFactory` a runtime registers. A provider registration names its endpoint in `adapter_config.baseURL` (an http(s) URL; `openAICompatBaseUrl` reads and checks it), the OpenAI API in `adapter_config.api` (`openAICompatApi` reads and checks it, with the base URL's default when absent), any extra request fields as `extraBody.*` keys (`adapter_config` is flat, so one key per field and dots nest: `"extraBody.chat_template_kwargs.enable_thinking": false`; `openAICompatExtraBody` expands and checks them), and, for an endpoint that needs a key, its secret in `secret_ref`; without one the adapter sends `'unused'`, as local runners expect.
- **`BASE_URLS`** — well-known endpoints: `OPENAI`, `OLLAMA_LOCAL`, `VLLM_LOCAL`, `LLAMA_SERVER_LOCAL`, `LM_STUDIO_LOCAL`, `OPENROUTER`, `GROQ`, `TOGETHER`, `FIREWORKS`, `DEEPINFRA`, `LITELLM_LOCAL`. Any other URL works too.
- **`ModelProvider`** — type re-export from `@kindgi/capabilities`.

## Example

```ts
import { createProviderRegistry } from '@kindgi/capabilities';
import { BASE_URLS, createOpenAICompatModelProvider } from '@kindgi/adapter-model-openai-compat';

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined) throw new Error('OPENAI_API_KEY is not set');

const openai = createOpenAICompatModelProvider({
  baseURL: BASE_URLS.OPENAI,
  apiKey,
  metadata: {
    id: 'openai',
    region: 'us',
    models: [
      {
        name: 'gpt-4o-mini',
        contextWindow: 128_000,
        features: ['tool-use', 'structured-output'],
        // Rates from the provider's published pricing.
        cost: { promptUsdPer1kTokens: 0.00015, completionUsdPer1kTokens: 0.0006 },
      },
    ],
  },
  clientOptions: { timeout: 30_000 },
});

const { registry } = createProviderRegistry();
registry.register(tenantId, openai);

const result = await openai.invoke({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'What is the status of order 1042?' }],
  tools: [
    {
      name: 'acme.orders.lookup',
      description: 'Fetch an order by id.',
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    },
  ],
});
for (const call of result.message.toolCalls ?? []) {
  console.log(call.name, call.arguments); // acme.orders.lookup { orderId: '1042' }
}
console.log(result.finishReason, result.costUsd);
```

A local runner uses the same factory: `baseURL: BASE_URLS.OLLAMA_LOCAL`, `apiKey: 'unused'`, and zero cost rates in `metadata`.

## Non-goals

- **Streaming.** Requests are sent with `stream: false`; `invoke()` resolves with the complete response.
- **Server-side conversation state** (Responses `previous_response_id`, `store: true`). Every call carries its whole conversation.
- **Pricing discovery.** Cost rates are caller-supplied per model.

## Related

- [`@kindgi/capabilities`](../../capabilities/) — `ModelProvider`, `ProviderMetadata`, and the provider registry.
- [`@kindgi/adapter-model-anthropic`](../model-anthropic/) — the Anthropic Messages API adapter, with a lazily resolved API key.
- [`@kindgi/adapter-model-in-process`](../model-in-process/) — local models inside the Node.js process, no HTTP endpoint.
