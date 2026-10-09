# `@kindgi/adapter-model-shared`

Shared plumbing for Kindgi's model adapters: what every adapter needs to turn a vendor's API into a [`@kindgi/capabilities`](../../capabilities/) `ModelProvider` the same way. The Azure OpenAI and Amazon Bedrock adapters are built on it.

Today's engine for sending the requests is the [AI SDK](https://ai-sdk.dev)'s provider packages (`@ai-sdk/*`), called at the provider-spec level (`doGenerate`). It never uses the `ai` package, its agent loop or Vercel's gateway, so no request goes anywhere but the vendor's own API. The engine sits behind one module, `@kindgi/adapter-model-shared/ai-sdk`, the only entry point whose types are a library's. Swapping it later touches that module and the adapters that hand their models in, nothing else.

## What every adapter gets

- **Retries are Kindgi's.** One send makes one HTTP attempt. The provider makes up to `attempts` in all (default 3) on a retryable failure: 408, 409, 429, 5xx, or no response.
  - It waits what the vendor asks (`retry-after-ms`, `retry-after`, up to 60 s), or backs off exponentially with jitter.
  - Each attempt is counted (`@kindgi/capabilities/attempts`): a result's `attempts`, or `attemptsOf(error)` for a failed call.
  - An abort, in flight or during a wait, rejects with the caller's reason.
- **Errors are typed.** A failed call throws `ModelProviderError` with a `kind`:
  - `auth`: 401, 403;
  - `rate-limited`: 429;
  - `unavailable`: 408 (the vendor timing out) and 5xx;
  - `context-too-long` and `content-filter`, read from the vendor's words on a 400, 413 or 422;
  - `invalid-request`;
  - `network`.
  It also has the HTTP `status`. Its message is the vendor's own words after the status (`401 {"message":"…"}`), as other adapters' failed calls read.
  - An adapter's own `ModelProviderError` (its sign-in failed, say) ends the call as it is, never retried.
- **A stop the library has no unified reason for** is `error`, except running out of context (Bedrock's `model_context_window_exceeded`), which is `length`.
- **The reasoning state survives a pause.** A provider's opaque state (reasoning with its signature or encrypted content, a tool call's thought signature) is kept, in order, in the first tool call's `signature`.
  - It goes back on the next call to the same model, so a durable run can stop after a tool call, restart, and resume with no loss.
  - Another model's state is never sent.
- **Tool names:** `.` → `__` on send and back on receive, since vendors refuse dots. The system prompt names them as sent.
- **Usage onto Kindgi's counters:** prompt (cache reads and writes included), completion, cache read and write, and reasoning tokens. The adapter's own cost formula prices them, and `rawUsage` is the vendor's usage as sent.
- **Settings a model refuses are dropped, with a warning:** a temperature on a model registered `sampling: false` gives `sampling-unsupported`, never a 400. Lowest thinking is the engine's portable reasoning level.
- **`traceparent`** is sent as a header only when the call has one.
- **For audit:** the served model (`servedModel`) and the vendor's request id (`providerRequestId`).

## Exports

**`@kindgi/adapter-model-shared`, in Kindgi's terms:**
- **`ModelProviderError`** (`kind`, `status`) and `ModelProviderErrorKind`;
- `kindOf(failure)` and `modelProviderError(failure, cause)`: a failed response as a typed error;
- `withRetries(send, policy)`, `backoffMs(headers, attempt)`, `RetryPolicy`, `RetryableFailure`: the retry policy, library-free.
- **`tokenCostUsd(model, usage, options?)`**: a call's cost from the model's registered rates. It covers prompt and completion, cache reads and writes as multiples of the prompt rate, the long-context tier and the data-residency uplift. The arithmetic is the same as the OpenAI-compatible and Anthropic adapters' own (a test holds them equal on the bundled presets). What a missing cache multiplier means is the adapter's to say: `cacheReadMultiplier` / `cacheWriteMultiplier`, default 1.

**`@kindgi/adapter-model-shared/ai-sdk`, where an adapter hands its model in:** `createAiSdkModelProvider(options)` returns a `ModelProvider`. Its `options`:
- `metadata`: the registration's `ProviderMetadata`;
- `languageModel(name, fetch)`: the engine's model for a model name, sending with the `fetch` it's given (each HTTP attempt is counted through it);
- `providerOptions?(model)`: provider options on every call (Azure: `{ azure: { store: false } }`);
- `cost(model, usage)`: the adapter's cost formula;
- `attempts?`: HTTP attempts in all on a retryable failure (default 3);
- `fetch?`: the fetch each attempt goes through, for an endpoint the registration chose: the runtime's (`AdapterFactoryInput.fetch`, which refuses the hosts its deployment forbids). Default: the global `fetch`;
- `beforeAttempt?()`: run before each HTTP attempt, inside the retries. An adapter checks its sign-in here when its library would report a failure as a plain error (Bedrock's), and throws a `ModelProviderError`;
- `explain?(error)`: a sentence after a failed call's message, where the vendor's words don't say what to check (Bedrock's 403). The kind, status and attempts stay as they are.

## Pins

The engine's packages change often (two releases of one of them in a day during the evaluation). Every `@ai-sdk/*` dependency here, and in the adapters built on it, is **pinned exactly** and bumped on purpose, with the live cases re-run per bump. Kindgi keeps its own copy of the AI SDK's source and of the exact package files it pins.
