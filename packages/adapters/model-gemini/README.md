# `@kindgi/adapter-model-gemini`

Gemini `ModelProvider` for [`@kindgi/capabilities`](../../capabilities/), on Google Cloud's Vertex AI. Wraps the official `@google/genai` client behind the framework's provider-neutral interface. One provider exposes every model in its `metadata.models[]`; `ModelCallInput.model` picks the model per call.

## Credentials

No API key. The client uses **Google Application Default Credentials**:

- on a laptop, `gcloud auth application-default login`;
- on Cloud Run and other Google Cloud runtimes, the attached service account;
- elsewhere, a service-account key (its JSON) passed as `credentials` — through a provider row's `secret_ref` when registered with a Kindgi server.

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

## Exports

- **`createGeminiProvider(options)`**: a `ModelProvider` whose `metadata` is `options.metadata`. `invoke()` throws when `input.model` is not one of `metadata.models[].name`.
- **`GeminiProviderOptions`**:
  - `metadata`: `ProviderMetadata` whose `models[]` are `GeminiModelInfo`. Caller-supplied; the API doesn't report pricing.
  - `vertex: { project, location }`: the Vertex AI project, and the location (`global` or a region).
  - `credentials?: () => string | Promise<string>`: a service-account key, resolved on every call. The client is rebuilt only when the resolved key changes, so a rotated key applies on the next call. Absent: Application Default Credentials.
  - `client?`: an injected `GeminiClient` (anything with `models.generateContent`), used as is. For tests.
- **`geminiAdapterFactory`** / **`GEMINI_ADAPTER_ID`** (`'@kindgi/adapter-model-gemini'`): the factory a server registers. A provider row carries:
  - `adapter_config.project` (required);
  - `metadata.region` as the location (`unspecified` means `global`);
  - an optional `secret_ref` holding a service-account key.
- **`vertexTarget(input)`**: the project and location a registration names, as the factory reads them.
- **`geminiAdapterEntry`**: the `AdapterFactoryEntry` a runtime registers, `geminiAdapterFactory` plus **`geminiCheckConfig(input)`**. The check reports what the factory would throw on (`adapter_config.api`, `secret_ref` on the Developer API, `adapter_config.project`, `metadata.region`) with the factory's own messages, without building anything.
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
