# `@kindgi/embedding`

Embedding provider interface and an in-memory provider registry for Kindgi. An embedding provider turns text into a fixed-length vector; adapters implement `EmbeddingProvider`, a deployment registers them once at boot, and consumers such as semantic search in [`@kindgi/memory`](../memory/) and agent retrieval in [`@kindgi/agents`](../agents/) take the registry and resolve a provider from it instead of receiving one per call.

## Purpose

Keep vectors consistent with the model that produced them. The registry is keyed by `describe().model`, the identifier storage layers use to tag stored embeddings, so a model can only be registered once: silently replacing the implementation behind a model that already has indexed vectors would corrupt the index. `dimensions()` must equal the length of every `embed()` result, so callers can size vector indexes at boot. Resolution without an explicit model succeeds only when exactly one provider is registered.

## Exports

- **`EmbeddingProvider`** — the adapter interface:
  - `embed(text)` — returns a `Promise<Float32Array>`.
  - `dimensions()` — vector length; must match every `embed()` result.
  - `describe()` — `{ name, version, model }`. `model` is the stable storage key; never rename it across versions.
- **`createEmbeddingProviderRegistry(seed?)`** — builds an in-memory registry, preserving registration order. A duplicate model in `seed` throws synchronously.
- **`EmbeddingProviderRegistry`** — the registry interface (process-wide, not tenant-scoped):
  - `register(provider)` — `Result<void, DuplicateEmbeddingProviderError>`; rejects a model that is already registered.
  - `resolve(model?)` — the provider for `model`; with no argument, the sole registered provider.
  - `getByModel(model)`, `has(model)`, `list()`, `size()`.
- **`EmbeddingError`** — union of the typed errors, discriminated by `code`:
  - **`NoEmbeddingProviderError`** (`no-embedding-provider`) — no model given and nothing is registered.
  - **`UnknownEmbeddingModelError`** (`unknown-embedding-model`) — `model` is not registered; `known` lists the registered models.
  - **`AmbiguousDefaultProviderError`** (`ambiguous-default-provider`) — no model given and more than one is registered; `known` lists them.
  - **`DuplicateEmbeddingProviderError`** (`duplicate-embedding-provider`) — returned by `register`.

## Example

```ts
import { createEmbeddingProviderRegistry, type EmbeddingProvider } from '@kindgi/embedding';

// An adapter over a self-hosted embedding endpoint.
function httpEmbeddingProvider(endpoint: string, model: string, dims: number): EmbeddingProvider {
  return {
    async embed(text) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) throw new Error(`embedding request failed: ${res.status}`);
      const { embedding } = (await res.json()) as { embedding: number[] };
      if (embedding.length !== dims) throw new Error(`expected ${dims} dimensions, got ${embedding.length}`);
      return Float32Array.from(embedding);
    },
    dimensions: () => dims,
    describe: () => ({ name: 'http-embedding', version: '1.0.0', model }),
  };
}

// Built once at boot; a duplicate model in the seed throws here.
const registry = createEmbeddingProviderRegistry([
  httpEmbeddingProvider('http://localhost:8080/embed', 'acme-embed-v1', 384),
]);

// No model given: resolves the sole registered provider.
const resolved = registry.resolve();
if (resolved.kind === 'err') throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
const vector = await resolved.value.embed('quarterly revenue by region');
console.log(vector.length === resolved.value.dimensions()); // true
```

## Non-goals

- **No bundled provider.** Semantic embedding is opt-in; register an adapter at boot. The Kindgi runtime offers a self-hosted local-model provider.
- **No replacement or re-dimensioning in place.** To change a model's dimensions, register it under a new `model` and migrate existing vectors separately.
- **No per-tenant model policy.** The registry is process-global; which model a tenant may use is a separate concern.
- **No vector storage or similarity search.** Storing and querying vectors belongs to the consuming layer, such as [`@kindgi/memory`](../memory/).

## Related

- [`@kindgi/memory`](../memory/) — `searchBySemantic` takes an `EmbeddingProviderRegistry` and an optional `embeddingModel`.
- [`@kindgi/agents`](../agents/) — `runRetrievals` takes the registry (`RetrievalBindings.embeddingRegistry`) for semantic retrieval intents.
- [`@kindgi/types`](../types/) — `Result`.
