# `@kindgi/adapter-model-gemini`

Gemini `ModelProvider` for [`@kindgi/capabilities`](../../capabilities/), on Google Cloud's Vertex AI. Wraps the official `@google/genai` client behind the framework's provider-neutral interface. One provider exposes every model in its `metadata.models[]`; `ModelCallInput.model` picks the model per call.

## Credentials

No API key. The client uses **Google Application Default Credentials**:

- on a laptop, `gcloud auth application-default login`;
- on Cloud Run and other Google Cloud runtimes, the attached service account;
- elsewhere, a service-account key (its JSON) passed as `credentials` — through a provider row's `secret_ref` when registered with a Kindgi server.

A Kindgi server with `KINDGI_TENANT_HOST_ACCESS=isolated` doesn't let tenant configuration sign in as the server (`serverCredentials: false`): a registration there needs `secret_ref`, and without one the check and the factory refuse it, naming `secret_ref`.

The account needs the Vertex AI User role (`roles/aiplatform.user`) in the project.

## Translation

One non-streaming `models.generateContent` call per `invoke`:

- `system` messages lift into `systemInstruction` (several join with a blank line). `user` messages become `user` turns, `assistant` messages `model` turns, and consecutive turns of one role merge.
- **Function calling.** Tool definitions become `functionDeclarations`, with the tool's JSON Schema as `parametersJsonSchema`. Assistant tool calls replay as `functionCall` parts. Tool results become `functionResponse` parts, named after the call they answer, with the tool's output under `response.output` (parsed when it's JSON).
  - Tool names go over the wire as they are. Gemini accepts `<pack>.<tool>` ids: a letter or `_` first, then letters, digits and `_ . : -`, at most 64 characters. Other names are refused.
- **Thought signatures.** Each `functionCall` part's `thoughtSignature` comes back as `ModelToolCall.signature`, and goes out again on the same call when the conversation continues. Gemini's thinking models need it to keep their reasoning across a tool round trip.
- **Thinking parts** (`thought: true`) are left out of the message text. Thinking tokens count as completion tokens, since they bill as output.
- **Structured output.** `structuredOutput` becomes `responseMimeType: 'application/json'` plus `responseJsonSchema`.
- `temperature`, `maxOutputTokens` (the call's, else the model's `ModelInfo.maxOutputTokens`) and `abortSignal` are passed through.
- **Retries.** A call that fails with a transient status (408, 429, 500, 502, 503, 504) is retried: three attempts in all, backing off from a second, with jitter. The `@google/genai` client retries only when it's told to, and the adapter tells it. A failed connection isn't retried. The result's `attempts` counts every attempt; a call that still fails throws the last error, and `attemptsOf(error)` (`@kindgi/capabilities/attempts`) counts them. An injected `client` keeps its own settings.
- **`finishReason`:**
  - a response with function calls → `tool-use`;
  - `STOP` or unspecified → `stop`;
  - `MAX_TOKENS` → `length`;
  - the safety, recitation, blocklist and sensitive-data stops, or a blocked prompt → `content-filter`;
  - anything else (a malformed or unexpected function call, too many tool calls, `OTHER`) → `error`.

## Cost

`costUsd` is computed from the response's usage against the picked model's `cost`:

- uncached prompt tokens at `promptUsdPer1kTokens`;
- cached prompt tokens at `promptUsdPer1kTokens × cachedPromptMultiplier` (default `0.25`, Gemini 2.5's implicit-cache discount);
- completion tokens, thinking included, at `completionUsdPer1kTokens`;
- `longContext: { thresholdTokens, promptUsdPer1kTokens, completionUsdPer1kTokens }`: a call whose prompt exceeds the threshold bills entirely at those rates, for a model whose price rises past a prompt size.

`usage.promptTokens` includes cached tokens and built-in tool prompts; `usage.cachedTokens` reports the cached ones when there are any.

## How much it thinks

Gemini 3 models can think before they answer, as much as Google sets by default. Gemini 3.8 Flash thinks on every call, and `low` is the least it takes. The thinking bills as output, and it counts against `maxOutputTokens`, so a high level with a small cap can end with no answer.

- **`thinkingLevels`** sets a level for each model it names: `minimal`, `low`, `medium` or `high`. That's Gemini's `thinkingLevel`, sent upper-cased on every call to that model. A model it doesn't name thinks as Google sets by default.
  - In code: `thinkingLevels: { 'gemini-3.8-flash': 'low' }`.
  - On a registration: `adapter_config.thinkingLevels: "gemini-3.8-flash=low,gemini-3.5-flash-lite=minimal"`.
- **Each model it names** needs `thinking` in `metadata.models`, and a level no lower than its `thinking.lowest`: Vertex AI refuses `minimal` on Gemini 3.8 Flash. Anything else is refused, naming the entry or the model, when the provider is made or registered.
- **A call's `thinking: 'lowest'`** (judges set it) still sends the model's `thinking.lowest`.
- **Gemini 2.5** takes a token budget instead of a level, and isn't covered.
- **It takes effect from the 0.2.0-rc.1 adapter.** An older one ignores the key, as the adapter ignores any `adapter_config` key it doesn't know. Keys are case-sensitive, so a misspelled one is ignored too.

## Exports

- **`createGeminiProvider(options)`**: a `ModelProvider` whose `metadata` is `options.metadata`. `invoke()` throws when `input.model` is not one of `metadata.models[].name`.
- **`GeminiProviderOptions`**:
  - `metadata`: `ProviderMetadata` whose `models[]` are `GeminiModelInfo`. Caller-supplied; the API doesn't report pricing.
  - `vertex: { project, location }`: the Vertex AI project, and the location (`global` or a region).
  - `credentials?: () => string | Promise<string>`: a service-account key, resolved on every call. The client is rebuilt only when the resolved key changes, so a rotated key applies on the next call. Absent: Application Default Credentials.
  - `client?`: an injected `GeminiClient` (anything with `models.generateContent`), used as is. For tests.
  - `thinkingLevels?: Record<string, GeminiThinkingLevel>`: a thinking level for each model it names (see [How much it thinks](#how-much-it-thinks)).
- **`geminiAdapterFactory`** / **`GEMINI_ADAPTER_ID`** (`'@kindgi/adapter-model-gemini'`): the factory a server registers. A provider row carries:
  - `adapter_config.project` (required);
  - `metadata.region` as the location (`unspecified` means `global`);
  - an optional `secret_ref` holding a service-account key;
  - an optional `adapter_config.thinkingLevels`, `"model=level,…"`.
- **`vertexTarget(input)`**: the project and location a registration names, as the factory reads them.
- **`geminiAdapterEntry`**: the `AdapterFactoryEntry` a runtime registers, `geminiAdapterFactory` plus **`geminiCheckConfig(input)`**. The check reports what the factory would throw on (`adapter_config.api`, `secret_ref` on the Developer API, `adapter_config.project`, `metadata.region`, `adapter_config.thinkingLevels`) with the factory's own messages, without building anything.
- **`GeminiThinkingLevel`**: `'minimal' | 'low' | 'medium' | 'high'`.
- **Cost helpers**: `computeCostUsd(usage, rates)`, `toFrameworkUsage(usageMetadata)`, `GeminiCostRates`, `GeminiModelInfo`, `DEFAULT_CACHED_PROMPT_MULTIPLIER`.
- **Translation helpers**: `toGeminiRequest(messages)`, `toGeminiFunctions(tools)`, `fromGeminiResponse(response)`, `mapFinishReason(reason)`, `checkFunctionName(name)`.

## Example

```ts
import { createGeminiProvider } from '@kindgi/adapter-model-gemini';

const gemini = createGeminiProvider({
  vertex: { project: 'my-project', location: 'global' },
  metadata: {
    id: 'gemini',
    region: 'global',
    models: [
      {
        name: 'gemini-3.8-flash',
        contextWindow: 1_048_576,
        features: ['tool-use', 'structured-output', 'long-context'],
        maxOutputTokens: 8_192,
        // Rates from Google's published pricing.
        cost: { promptUsdPer1kTokens: 0.00075, completionUsdPer1kTokens: 0.00375 },
      },
    ],
  },
});

const result = await gemini.invoke({
  model: 'gemini-3.8-flash',
  messages: [{ role: 'user', content: 'Summarise the grievance in one sentence.' }],
});
```

With a Kindgi server, register the provider instead (`kindgi providers register --spec=@provider.json`): `{ metadata, adapter_id: '@kindgi/adapter-model-gemini', adapter_config: { project } }`.

## Tests

- `tests/translate.test.ts` and `tests/provider.test.ts` run against a fake client.
- `tests/live.test.ts` calls Vertex AI. It runs only when `GOOGLE_CLOUD_PROJECT` is set (with `GOOGLE_CLOUD_LOCATION`, default `global`, and `KINDGI_LIVE_GEMINI_MODEL`, default `gemini-2.5-flash`) and Application Default Credentials are available. It covers a plain answer and a full tool round trip that sends the thought signature back.
