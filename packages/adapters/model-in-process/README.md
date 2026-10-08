# `@kindgi/adapter-model-in-process`

In-process `ModelProvider` for [`@kindgi/capabilities`](../../capabilities/). Runs small instruction-tuned models inside the Node.js process through `@huggingface/transformers` (ONNX runtime): no API key, no external process, no network once the weights are cached, and zero USD cost. Intended as the cheapest routing tier — classification, extraction, routing, smoke tests — not as a replacement for hosted models on reasoning tasks.

## Purpose

Give the capability router a local provider it can match like any other. Every model reports `cost` of `0`, the provider's `region` is `'in-process'`, and `attributes` carry `in-process` plus each model's tier and `suitableFor` hints (`routing`, `classification`, `local`, `lower-cost`, …) for preference matching. `prepareInProcessModel` downloads weights ahead of the first call and streams progress in the `PrepareEvent` shape used by `AdapterFactoryEntry.prepare`.

## Exports

- **`inProcessAdapterEntry`** (`IN_PROCESS_ADAPTER_ID`) — the `AdapterFactoryEntry` a runtime registers: **`inProcessAdapterFactory`** (a registration lists models by their `MODEL_SPECS` key in `metadata.models[].name`), `prepare` (`prepareInProcessModel`), and **`inProcessCheckConfig(input)`**, which reports a model that isn't one of `MODEL_SPECS` (`metadata.models`) with the factory's own message.
- **`createInProcessModelProvider(options?)`** — returns a `ModelProvider`. Construction is cheap: each model's pipeline loads on the first `invoke()` that names it (concurrent first calls share one load), downloading weights if they are not cached yet. With `@huggingface/transformers` 4.x the default cache is a `.cache` directory inside that package's install location; `cacheDir` redirects the model files (transformers.js 4.3 can still write a model's `config.json` to its default cache). Throws when `models` is empty; `invoke()` throws for a model the provider does not expose.
  - `invoke()` passes each message to the model's chat template as `{ role, content }`, uses `maxOutputTokens` as `max_new_tokens` (default `512`), samples only when `temperature > 0` (greedy otherwise), and returns `finishReason: 'stop'` and `costUsd: 0`. Token counts come from the model's tokenizer, falling back to about four characters per token. `abortSignal` is not observed.
- **`InProcessProviderOptions`**:
  - `models?: readonly LocalModel[]` — models to expose; default `[DEFAULT_LOCAL_MODEL]`.
  - `providerId?: string` — `metadata.id`; default `in-process/<models joined with '+'>`. Lets the same model set be registered twice under different ids.
  - `cacheDir?: string` — directory for downloaded model files, passed to transformers.js as `cache_dir`.
- **`LocalModel`**, **`MODEL_SPECS`**, **`ModelSpec`**, **`DEFAULT_LOCAL_MODEL`** — the closed model set and its per-model spec (`hfName`, `approxDownloadMb`, `contextWindow`, `toolUse`, `tier`, `suitableFor`, `dtype`). All use `q4f16` weights:

  | `LocalModel` | Hugging Face repo | Download | Context | Tier |
  |---|---|---|---|---|
  | `smollm2-135m` | `HuggingFaceTB/SmolLM2-135M-Instruct` | ~118 MB | 8,192 | ultra-light |
  | `smollm2-360m` (default) | `HuggingFaceTB/SmolLM2-360M-Instruct` | ~273 MB | 8,192 | small |
  | `qwen3-0.6b` | `onnx-community/Qwen3-0.6B-ONNX` | ~550 MB | 32,768 | medium |

- **`prepareInProcessModel(params?)`** / **`PrepareInProcessParams`** — `AsyncIterable<PrepareEvent>` for `{ model?, cacheDir? }` (model defaults to `DEFAULT_LOCAL_MODEL`). Loads the model once, yielding `progress` events (with `ratio`, `loadedBytes`, `totalBytes`, `file` when known) and then a single `ready` or `error`. The loaded pipeline is not shared: a provider loads its own copy from the cache on first `invoke()`.
- **`ModelProvider`**, **`PrepareEvent`** — type re-exports from `@kindgi/capabilities`.

## Example

```ts
import { createProviderRegistry } from '@kindgi/capabilities';
import {
  createInProcessModelProvider,
  prepareInProcessModel,
} from '@kindgi/adapter-model-in-process';

// Download (or verify the cached copy of) the weights before serving traffic.
for await (const event of prepareInProcessModel({ model: 'smollm2-360m' })) {
  if (event.kind === 'error') throw new Error(event.message);
  if (event.kind === 'progress' && event.ratio !== undefined) {
    console.log(`${event.file ?? 'model'} ${Math.round(event.ratio * 100)}%`);
  }
}

const provider = createInProcessModelProvider({ models: ['smollm2-360m'] });
const { registry } = createProviderRegistry();
registry.register(tenantId, provider); // metadata.id: 'in-process/smollm2-360m'

const result = await provider.invoke({
  model: 'smollm2-360m',
  messages: [
    { role: 'system', content: 'Classify the ticket as billing, bug or other. Reply with one word.' },
    { role: 'user', content: 'I was charged twice for the acme plan this month.' },
  ],
  maxOutputTokens: 8,
});
console.log(result.message.content, result.usage); // costUsd is always 0
```

## Non-goals

- **Streaming.** `invoke()` resolves with the complete response.
- **Tool calling and structured output.** `tools`, `structuredOutput`, and message `toolCalls` / `toolCallId` are not passed to the model; responses are plain text.
- **Arbitrary Hugging Face models.** Only the three `LocalModel` keys are selectable.

## Related

- [`@kindgi/capabilities`](../../capabilities/) — `ModelProvider`, the provider registry, and `AdapterFactoryEntry`.
- [`@kindgi/adapter-model-openai-compat`](../model-openai-compat/) — for local runners that expose an OpenAI-compatible HTTP endpoint instead.
- [`@kindgi/dev-echo-provider`](../../dev-echo-provider/) — deterministic scripted provider for tests.
