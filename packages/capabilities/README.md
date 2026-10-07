# `@kindgi/capabilities`

Capability declarations, a tenant-scoped model-provider registry, and a deterministic router for Kindgi. An agent declares what it needs from a model (features, context window, cost, region, latency, provider or model allow and deny lists) and what it prefers; the router picks a `(provider, model)` pair from the tenant's registered providers that meets every hard requirement and the tenant's policy, ranked by the preferences. The package also defines `ModelProvider`, the provider-neutral contract that model adapters implement.

## Purpose

Keep agent definitions independent of any one model vendor. Agents state requirements instead of naming a model; the binding to a concrete model happens at run time, and when nothing qualifies the router returns a structured explanation of which candidate failed which requirement. Providers are registered per tenant, so routing for one tenant never sees another tenant's providers.

## Exports

- **Declaring requirements**
  - **`Capability`** — `{ kind?, needs, prefer?, budget? }`. `kind` defaults to `DEFAULT_CAPABILITY_KIND` (`'llm-inference'`); `BUILT_IN_CAPABILITY_KINDS` / `BuiltInCapabilityKind` list the well-known kinds, and `CapabilityKind` is an open string.
  - **`Requirement`** — hard constraints: `{ feature }`, `{ contextWindow: { op, value } }`, `{ costPerCall: { op, usd } }` (compared against the model's prompt price per 1K tokens), `{ region }`, `{ p95LatencyMs: { op, value } }`, `{ providers: { allow?, deny? } }`, `{ models: { allow?, deny? } }`. Operators are `ComparisonOp` (`>=`, `>`, `=`, `<=`, `<`) and `UpperBoundOp` (`<=`, `<`) for latency.
  - **`Preference`** — `{ feature, weight }`; `feature` is a `Feature` or a provider attribute such as `'lower-cost'`. Weights add up per candidate and may be negative.
  - **`FEATURES`** / **`Feature`** — the closed feature set: `structured-output`, `vision`, `audio-input`, `audio-output`, `tool-use`, `parallel-tool-use`, `thinking`, `long-context`, `code-execution`, `web-search`, `file-search`, `streaming`, `batch`. `structured-output` means the model can follow a JSON schema natively (`ModelCallInput.structuredOutput`, where its adapter maps it); an agent's typed output doesn't use that yet, and on every provider is checked by parse and repair.
  - **`Budget`** — `maxCostUsd`, `maxTokens`, `maxDurationMs`.
  - **`defineCapability(spec)`** — validates a declaration against the bundled `capability.schema.json` (the same file as in [`@kindgi/specs`](../specs/); its `$id` is exported as `CAPABILITY_SCHEMA_URI`) and returns `Result<Capability, InvalidCapabilityError>`. The schema accepts `needs`, `prefer` and `budget` with every requirement except `models`, so a declaration that sets `kind` or uses a `models` requirement is rejected here even though the type and the router accept it.
- **Providers**
  - **`ModelProvider`** — `metadata` plus `invoke(input: ModelCallInput): Promise<ModelCallResult>`.
  - **`ProviderMetadata`** — `id`, `region` (`'unspecified'` if not region-scoped), `models`, and optional `attributes`, `description`, `capabilityKind`. One provider is one connection that can expose several models.
  - **`ModelInfo`** — `name`, `contextWindow`, `features`, `cost` (`promptUsdPer1kTokens`, `completionUsdPer1kTokens`), and optional `p95LatencyMs`, `maxOutputTokens`, `description`.
- **Model call shape** — **`ModelCallInput`** (`model`, `messages`, optional `tools`, `structuredOutput`, `temperature`, `maxOutputTokens`, `abortSignal`), **`ModelMessage`** (roles `system`, `user`, `assistant`, `tool`), **`ModelToolCall`**, **`ModelToolDefinition`**, **`StructuredOutputRequest`**, **`ModelCallResult`** (`message`, `finishReason`, `usage`, `costUsd`, `durationMs`, `provider`), **`UsageCounters`**. Adapters translate these to and from their vendor SDKs.
- **Registry**
  - **`createProviderRegistry(seed?)`** — in-memory registry. Returns `{ registry, register }`: `register(tenantId, provider)` validates the metadata and returns a `Result` (`invalid-provider`, `duplicate-provider`); `registry` is the `ProviderRegistry` view, whose own `register` throws on the same errors.
  - **`ProviderRegistry`** — `register`, `get`, `list`, `has`, all keyed by `tenantId`, plus optional `hydrate(tenantId)` and `invalidate(tenantId)` for implementations backed by persistent storage.
- **Routing**
  - **`route(input: RouteInput)`** — returns `Result<RoutingDecision, CapabilityError>`. It expands each provider into one candidate per model, filters by `kind`, `needs` and the tenant policy, ranks by summed preference weight, moves candidates matching `preferredProvider` / `preferredModel` to the front, and breaks ties on `(providerId, modelName)`. The same inputs always produce the same decision.
  - **`RouteInput`** — `capability`, `providers` (already scoped to one tenant, e.g. `registry.list(tenantId)`), and optional `tenantPolicy`, `preferredProvider`, `preferredModel`.
  - **`RoutingDecision`** — the chosen `provider` and `model`, a human-readable `reason`, and `alternates` (`ProviderModelPick[]`) in rank order.
  - **`matchTuples(input)`** — the filtering step on its own: the passing candidates, unranked, or `capability-unsatisfiable` when none pass.
  - **`TenantPolicy`** — `tenantId`, provider and model `allow` / `deny` lists, `regionAllow`, `maxCostPerCallUsd`, `maxTokensPerCall`. An allow list (or `regionAllow`) that is present restricts even when empty: `[]` allows nothing.
- **Adapter factories** — **`createAdapterFactoryRegistry(seed?)`** returns an **`AdapterFactoryRegistry`** (`register`, `get`, `has`, `list`): a deployment-wide map from adapter id to the code that builds providers. An **`AdapterFactoryEntry`** holds `adapterId`, `capabilityKind`, a `factory` (**`AdapterFactory`**: `(input: AdapterFactoryInput) => ModelProvider`, where `AdapterFactoryInput` is `metadata` plus an optional `resolveApiKey`), an optional `prepare(params)` that streams **`PrepareEvent`**s (`progress`, `ready`, `error`) for downloads or warm-up, and an optional `checkConfig(input)`: the adapter's static check of a provider registration (**`AdapterConfigCheckInput`**: `metadata`, `config`, `hasSecretRef`; no network, no secret read), returning **`AdapterConfigProblem`**s (`field`, `message`). Each problem's message is the error `factory` throws for it; the runtime runs the check when a provider registers. Registering the same id twice throws.
- **Errors** — **`CapabilityError`**, a union of `InvalidCapabilityError`, `InvalidProviderError`, `DuplicateProviderError`, `CapabilityUnsatisfiableError` and `BudgetExceededError`. `CapabilityUnsatisfiableError.reasons` lists, for each requirement that rejected at least one candidate, the candidates that satisfied it and a structured **`RejectionReason`** for each that did not (`missing-feature`, `context-window-mismatch`, `region-mismatch`, `tenant-denied`, `capability-kind-mismatch`, …).

## Example

```ts
import { createProviderRegistry, defineCapability, route } from '@kindgi/capabilities';
import type { ModelProvider } from '@kindgi/capabilities';
import type { TenantId } from '@kindgi/types';

// One connection to a model vendor, exposing two models.
const acmeLlm: ModelProvider = {
  metadata: {
    id: 'acme-llm',
    region: 'eu-west-1',
    attributes: ['lower-cost'],
    models: [
      {
        name: 'acme-large',
        contextWindow: 200_000,
        features: ['tool-use', 'structured-output', 'streaming'],
        cost: { promptUsdPer1kTokens: 0.003, completionUsdPer1kTokens: 0.015 },
        p95LatencyMs: 4_000,
      },
      {
        name: 'acme-small',
        contextWindow: 32_000,
        features: ['tool-use'],
        cost: { promptUsdPer1kTokens: 0.0002, completionUsdPer1kTokens: 0.0008 },
      },
    ],
  },
  invoke: (input) => callAcmeApi(input), // your vendor SDK call
};

const tenantId = process.env.TENANT_ID as TenantId;
const { registry, register } = createProviderRegistry();
const registered = register(tenantId, acmeLlm);
if (registered.kind === 'err') throw new Error(registered.error.message);

const capability = defineCapability({
  needs: [{ feature: 'tool-use' }, { contextWindow: { op: '>=', value: 100_000 } }],
  prefer: [{ feature: 'lower-cost', weight: 1 }],
});
if (capability.kind === 'err') throw new Error(capability.error.message);

const decision = route({
  capability: capability.value,
  providers: registry.list(tenantId),
  tenantPolicy: { tenantId, regionAllow: ['eu-west-1'] },
});
if (decision.kind === 'err') {
  if (decision.error.code === 'capability-unsatisfiable') {
    for (const r of decision.error.reasons) {
      console.error(r.requirement, r.rejectingProviders.map((p) => `${p.id}: ${p.reason.code}`));
    }
  }
  process.exit(1);
}

// acme-small fails the context-window requirement, so this is acme-llm / acme-large.
const { provider, model } = decision.value;
const reply = await provider.invoke({
  model: model.name,
  messages: [{ role: 'user', content: 'Summarize clause 4.2 in one sentence.' }],
});
console.log(reply.message.content, reply.costUsd);
```

## Non-goals

- **No vendor adapters.** Concrete `ModelProvider` implementations live in adapter packages such as those under [`packages/adapters`](../adapters/).
- **No cost metering.** `Budget` and `BudgetExceededError` describe limits; nothing in this package tracks spend or enforces them.
- **No retries or failover.** `route` returns ranked `alternates`; retrying with the next candidate is up to the caller.
- **No persistence.** Both registries are in-memory. Implementations backed by storage plug in through `ProviderRegistry.hydrate` and `invalidate`.

## Related

- [`@kindgi/agents`](../agents/) — routes an agent's capability declaration with `route` at the start of every turn.
- [`@kindgi/specs`](../specs/) — `capability.schema.json`, the wire schema `defineCapability` validates against.
- [`@kindgi/dev-echo-provider`](../dev-echo-provider/) — a `ModelProvider` for local development.
- [`@kindgi/types`](../types/) — `TenantId` and `Result`.
