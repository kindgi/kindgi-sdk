// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, RunId, TenantId } from '@kindgi/types';

/**
 * The closed set of feature flags an agent can require. Matches
 * `@kindgi/specs/capability.schema.json` FeatureRequirement enum. Providers self-
 * report which of these they satisfy.
 */
export const FEATURES = [
  'structured-output',
  'vision',
  'audio-input',
  'audio-output',
  'tool-use',
  'parallel-tool-use',
  'thinking',
  'long-context',
  'code-execution',
  'web-search',
  'file-search',
  'streaming',
  'batch',
] as const;

export type Feature = (typeof FEATURES)[number];

/** Comparison operator used by numeric requirements (context, cost, latency). */
export type ComparisonOp = '>=' | '>' | '=' | '<=' | '<';

/** Numeric-comparison-only operators (latency can only bound from above). */
export type UpperBoundOp = '<=' | '<';

/**
 * One member of the Requirement union — hard constraints that MUST hold.
 *
 * `providers` filters on `ProviderMetadata.id` (vendor connection);
 * `models` filters on `ModelInfo.name` (specific model within a
 * connection). Both may appear in the same capability declaration —
 * "any provider EXCEPT anthropic, and any model EXCEPT haiku."
 */
export type Requirement =
  | { readonly feature: Feature }
  | { readonly contextWindow: { readonly op: ComparisonOp; readonly value: number } }
  | { readonly costPerCall: { readonly op: ComparisonOp; readonly usd: number } }
  | { readonly region: string }
  | { readonly p95LatencyMs: { readonly op: UpperBoundOp; readonly value: number } }
  | {
      readonly providers: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
    }
  | {
      readonly models: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
    };

/**
 * A soft preference. Router filters by `needs` first, then ranks the
 * survivors by summed weights of matched preferences.
 *
 * `feature` may be a canonical Feature name (e.g. `'thinking'`) or a
 * soft attribute the provider self-reports (`'lower-cost'`,
 * `'lower-latency'`, `'higher-accuracy'`, `'local'`, etc.). Weight can be
 * negative (deprioritize).
 */
export interface Preference {
  readonly feature: string;
  readonly weight: number;
}

/**
 * Per-invocation budget. Declarative: carried with the declaration but not
 * enforced by the runtime (per-turn spend is capped by the agent's
 * `budget.maxCostUsd`).
 */
export interface Budget {
  readonly maxCostUsd?: number;
  readonly maxTokens?: number;
  readonly maxDurationMs?: number;
}

/**
 * A capability declaration. Every agent (or every model-invoking node)
 * declares one; the router uses it to pick a provider.
 *
 * `kind` discriminates the resource type being requested. An absent
 * value is equivalent to `'llm-inference'`. Non-LLM kinds (`embedding`, `gpu-compute`,
 * `sandbox-exec`, `browser-session`) are declared here as strings so
 * adapter packages can register providers of that kind without a
 * schema break. The router filters providers by
 * `metadata.capabilityKind === capability.kind`.
 */
export interface Capability {
  readonly kind?: CapabilityKind;
  readonly needs: readonly Requirement[];
  readonly prefer?: readonly Preference[];
  readonly budget?: Budget;
}

/**
 * Open string discriminating capability kinds. Well-known values
 * enumerated in `BUILT_IN_CAPABILITY_KINDS`. Adapters register
 * providers of other kinds by declaring their own strings; the router
 * matches strictly on equality.
 */
export type CapabilityKind = string;

/** Well-known capability kinds — for enums, schema validation, docs. */
export const BUILT_IN_CAPABILITY_KINDS = [
  'llm-inference',
  'embedding',
  'gpu-compute',
  'sandbox-exec',
  'browser-session',
] as const;
export type BuiltInCapabilityKind = (typeof BUILT_IN_CAPABILITY_KINDS)[number];

/** Default kind used when Capability.kind is omitted. */
export const DEFAULT_CAPABILITY_KIND: CapabilityKind = 'llm-inference';

/**
 * Structured rejection reason surfaced when a provider fails a
 * requirement. Each variant carries `code` (for programmatic
 * matching) and `message` (for logs). Downstream callers can
 * `switch (r.code)` to route on specific failure modes without
 * string-parsing.
 *
 * The router's requirement checks return this discriminated union
 * (rather than a bare string) so consumers of
 * `CapabilityUnsatisfiableError.reasons[].rejectingProviders[].reason`
 * can inspect programmatically.
 */
export type RejectionReason =
  | { readonly code: 'missing-feature'; readonly message: string; readonly feature: string }
  | {
      readonly code: 'context-window-mismatch';
      readonly message: string;
      readonly observed: number;
      readonly op: ComparisonOp;
      readonly wanted: number;
    }
  | {
      readonly code: 'cost-exceeds-cap';
      readonly message: string;
      readonly observedUsdPer1k: number;
      readonly op: ComparisonOp;
      readonly wantedUsd: number;
    }
  | {
      readonly code: 'region-mismatch';
      readonly message: string;
      readonly observed: string;
      readonly wanted: string;
    }
  | { readonly code: 'p95-latency-unknown'; readonly message: string }
  | {
      readonly code: 'p95-latency-exceeds';
      readonly message: string;
      readonly observedMs: number;
      readonly op: UpperBoundOp;
      readonly wantedMs: number;
    }
  | {
      readonly code: 'provider-on-denylist';
      readonly message: string;
      readonly providerId: string;
    }
  | {
      readonly code: 'provider-not-in-allowlist';
      readonly message: string;
      readonly providerId: string;
      readonly allow: readonly string[];
    }
  | {
      readonly code: 'model-on-denylist';
      readonly message: string;
      readonly modelName: string;
    }
  | {
      readonly code: 'model-not-in-allowlist';
      readonly message: string;
      readonly modelName: string;
      readonly allow: readonly string[];
    }
  | {
      readonly code: 'tenant-denied';
      readonly message: string;
      readonly providerId: string;
    }
  | {
      readonly code: 'tenant-not-allowed';
      readonly message: string;
      readonly providerId: string;
    }
  | {
      readonly code: 'tenant-model-denied';
      readonly message: string;
      readonly modelName: string;
    }
  | {
      readonly code: 'tenant-model-not-allowed';
      readonly message: string;
      readonly modelName: string;
    }
  | {
      readonly code: 'tenant-region-not-allowed';
      readonly message: string;
      readonly observed: string;
      readonly allow: readonly string[];
    }
  | {
      readonly code: 'tenant-cost-cap-exceeded';
      readonly message: string;
      readonly observedUsd: number;
      readonly capUsd: number;
    }
  | {
      readonly code: 'capability-kind-mismatch';
      readonly message: string;
      readonly observed: CapabilityKind;
      readonly wanted: CapabilityKind;
    }
  | { readonly code: 'unknown-requirement'; readonly message: string };

/**
 * Per-model metadata. A provider row exposes one or more models (e.g.
 * Anthropic exposing Sonnet + Opus + Haiku under one API key); each
 * `ModelInfo` describes one entry the router can select. The router
 * picks a `(provider, model)` tuple per invocation, and the caller
 * threads `ModelCallInput.model = <ModelInfo.name>` so the adapter
 * knows which model to invoke.
 *
 * Adapters may widen `cost` via intersection types when they need
 * vendor-specific fields (e.g. Anthropic prompt-cache multipliers) —
 * the framework declares the mandatory shape, adapters extend.
 */
export interface ModelInfo {
  /** Vendor-facing model id passed to the SDK (e.g. `claude-sonnet-4-6`). */
  readonly name: string;
  /** Context window in tokens. */
  readonly contextWindow: number;
  /** Features this model supports (tool-use, thinking, structured-output, ...). */
  readonly features: readonly Feature[];
  /**
   * Cost per 1K tokens. Prompt + completion billed separately; both
   * required. Denominated in USD.
   */
  readonly cost: {
    readonly promptUsdPer1kTokens: number;
    readonly completionUsdPer1kTokens: number;
  };
  /** Best-effort p95 latency estimate in ms — varies by model. */
  readonly p95LatencyMs?: number;
  /**
   * Fallback cap on output tokens. Adapters that require max_tokens on
   * every request (e.g. Anthropic) use this when
   * `ModelCallInput.maxOutputTokens` is unset.
   */
  readonly maxOutputTokens?: number;
  /** Short per-model description surfaced in logs. */
  readonly description?: string;
}

/**
 * What a `ModelProvider` reports about itself so the router can match
 * capabilities against it without invoking. Static metadata — no side
 * effects, no network. Every field is provider-declared and the router
 * trusts it; misrepresentation is a provider bug.
 *
 * Provider-level fields (`id`, `region`, `attributes`) describe the
 * connection; per-model fields (context window, cost, features) live
 * under `models[]` so one connection can expose multiple models. The
 * router picks a `(provider, model)` tuple per invocation.
 */
export interface ProviderMetadata {
  readonly id: string;
  /**
   * Region the connection routes to. All models on this provider share
   * the region (Vertex-AI-Anthropic vs Bedrock-Anthropic vs
   * Anthropic-direct are separate provider rows, one per region).
   * `'unspecified'` if not region-scoped.
   */
  readonly region: string;
  /**
   * Models this connection exposes. Non-empty — a provider with zero
   * models is unusable and rejected at registration. `models[i].name`
   * must be unique within the list.
   */
  readonly models: readonly ModelInfo[];
  /**
   * Soft attributes the provider self-reports for preference-ranking.
   * Examples: `'local'`, `'lower-cost'`, `'higher-accuracy'`. Opaque to
   * the router — matched by string equality against `Preference.feature`.
   */
  readonly attributes?: readonly string[];
  /** Short human description of the connection surfaced in logs + errors. */
  readonly description?: string;
  /**
   * Kind of resource this provider fulfils. Optional — an absent value
   * defaults to `'llm-inference'`. Adapters for non-LLM kinds
   * (embedding, GPU compute, sandboxes, ...) set this explicitly. The router filters providers by
   * `metadata.capabilityKind === capability.kind`.
   */
  readonly capabilityKind?: CapabilityKind;
  /**
   * A fallback serves a capability only when no other provider
   * satisfies it — e.g. `kindgi dev`'s scripted `dev-echo`, which keeps
   * agent turns runnable until a real model is registered. A turn routed
   * to one says so (`RoutingDecision.fallback`).
   */
  readonly fallback?: boolean;
  /**
   * Bookkeeping, such as who manages the provider: string keys to
   * string values. The router ignores them. The limits and the
   * convention key (`kindgi.com/managed-by`) are in `provider-labels.ts`.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * A single message in a model call. Standardised wire shape — provider
 * adapters translate to/from their vendor SDK format.
 */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text content. Tool-use payloads carry their own fields; text may be empty. */
  readonly content: string;
  /** For role='tool': the tool call id being responded to. */
  readonly toolCallId?: string;
  /** For role='assistant': tool calls the model wants executed. */
  readonly toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON arguments as parsed object. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /**
   * An opaque token the provider attached to this call and needs back
   * when the conversation continues — Gemini's thought signature, for
   * example. Callers keep it with the call, unchanged; only the adapter
   * that produced it reads it.
   */
  readonly signature?: string;
}

/** Tool definition passed to a model call — JSON-Schema-shaped, provider-neutral. */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Structured-output request — the model returns JSON matching this
 * schema. Shape aligns with OpenAI's `response_format.json_schema`.
 *
 * Adapter coverage:
 *   - `@kindgi/adapter-model-openai-compat` — translates to
 *     `response_format: { type: "json_schema", json_schema: { name,
 *     schema, strict: true } }` on Chat Completions, and to
 *     `text.format: { type: "json_schema", name, schema, strict: true }`
 *     on OpenAI's Responses API.
 *   - `@kindgi/adapter-model-anthropic` — ignores it (see that
 *     package's README).
 */
export interface StructuredOutputRequest {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/**
 * The input to a model invocation. All fields provider-agnostic; each
 * adapter translates to its vendor SDK format.
 */
export interface ModelCallInput {
  /**
   * Which model to invoke. Must match one of the receiving provider's
   * `metadata.models[i].name`. Set by the caller from
   * `RoutingDecision.model.name` (typical path) or hand-picked when
   * the caller has a specific pin in mind. Adapters that don't
   * recognize the name reject with an `unknown-model` error.
   */
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly structuredOutput?: StructuredOutputRequest;
  /** Sampling controls — providers translate to their equivalent. */
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Cooperative cancellation. Handlers should observe. */
  readonly abortSignal?: AbortSignal;
}

/**
 * A model call's token counts. `promptTokens` and `completionTokens` are
 * the totals; the optional counts are parts of them, there when the
 * provider reports them (a reported 0 is 0; a part it doesn't report is
 * absent):
 *   - `cacheReadTokens` and `cacheWriteTokens` are part of `promptTokens`;
 *   - `reasoningTokens` are part of `completionTokens`.
 * Nothing is folded away: the provider's own counts are in
 * `ModelCallResult.rawUsage`.
 */
export interface UsageCounters {
  /** Every input token, cache reads and writes included. */
  readonly promptTokens: number;
  /** Every output token, reasoning included. */
  readonly completionTokens: number;
  /** Prompt tokens read from the provider's prompt cache. */
  readonly cacheReadTokens?: number;
  /** Prompt tokens written to the provider's prompt cache. */
  readonly cacheWriteTokens?: number;
  /** Completion tokens the model spent reasoning ("thinking"). */
  readonly reasoningTokens?: number;
}

/**
 * The result of a model invocation. `finishReason` matches OpenAI-style
 * conventions; adapters normalize to this set.
 */
/** A provider's warning about an answer (`ModelCallResult.warnings`). */
export interface ModelCallWarning {
  readonly code: string;
  readonly message: string;
}

export interface ModelCallResult {
  readonly message: ModelMessage;
  readonly finishReason: 'stop' | 'length' | 'tool-use' | 'content-filter' | 'error';
  readonly usage: UsageCounters;
  /**
   * Denominated in USD. Provider computes this from the actual token
   * usage against its cost table. Cost meter uses it directly rather
   * than re-computing (in case pricing changes between adapter
   * versions).
   */
  readonly costUsd: number;
  readonly durationMs: number;
  /** Provider + model actually invoked (in case the router picked a variant). */
  readonly provider: { readonly id: string; readonly model: string };
  /**
   * What the caller should know about this answer, each with a stable
   * `code` (dev-echo marks every answer `dev-echo-not-a-model`). An agent
   * turn collects them into its result's `warnings`.
   */
  readonly warnings?: readonly ModelCallWarning[];
  /**
   * The exact model version the vendor says answered. Vendors alias: a
   * `…-pro` request can be served by `…-pro-001`.
   */
  readonly servedModel?: string;
  /** The vendor's id for the request: Anthropic's `request-id`, OpenAI's `x-request-id`, Gemini's `responseId`. */
  readonly providerRequestId?: string;
  /** HTTP attempts the call took, its client's own retries included. */
  readonly attempts?: number;
  /** The vendor's usage object, exactly as it reported it. */
  readonly rawUsage?: Readonly<Record<string, unknown>>;
}

/**
 * One model call, as a usage sink records it: who made it (tenant,
 * project, run, agent, step), which provider and model answered, and what
 * the call used. Never the messages.
 */
export interface ModelUsageRecord {
  /** The call's id, unique per call; its provenance node carries it too. */
  readonly callId: string;
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly runId?: RunId;
  readonly agentId?: string;
  readonly agentVersion?: string;
  readonly conversationId?: string;
  /** The step of the run that made the call (`model-call`, `evaluate-guardrails`). */
  readonly nodeId?: string;
  /** The turn's step: its loop iteration. */
  readonly step?: number;
  /**
   * What the call was for, when it isn't the turn's own model step:
   * `guardrail-judge:<guardrail id>`.
   */
  readonly purpose?: string;
  readonly providerId: string;
  /** The model of the provider invoked. */
  readonly model: string;
  /** The router picked a fallback provider (`ProviderMetadata.fallback`). */
  readonly fallback?: boolean;
  /** When the call ended (ISO 8601). */
  readonly occurredAt: string;
  /** `ok`: the provider answered. `failed`: the call threw. */
  readonly status: 'ok' | 'failed';
  /** What the answer used, and what the vendor said about it (`ok`). */
  readonly result?: Omit<ModelCallResult, 'message'>;
  /**
   * Why the call failed (`failed`), and the HTTP attempts it took before
   * it did, when they were counted (`attemptsOf`).
   */
  readonly error?: { readonly message: string; readonly attempts?: number };
  /** How long the call took, failed or not. */
  readonly durationMs: number;
  /**
   * Set on a replay turn's calls: the past run it re-runs (`of`) and the
   * eval run it's for, so eval spend can be told apart from production.
   */
  readonly replay?: { readonly of: string; readonly evalRunId: string };
}

/**
 * Where model calls are recorded: the runtime's cost ledger. The caller
 * awaits `record` before it goes on with the answer, and a `record` that
 * throws fails the caller: a model call isn't left unrecorded. Recording
 * the same `callId` again changes nothing.
 */
export interface UsageSink {
  record(call: ModelUsageRecord): Promise<void>;
}

/**
 * A registered provider — metadata + invoke function. Registered once at
 * pack init; invoked many times by the router.
 */
export interface ModelProvider {
  readonly metadata: ProviderMetadata;
  invoke(input: ModelCallInput): Promise<ModelCallResult>;
}

/**
 * Registry the router consults. Tenant-scoped: each tenant owns its
 * own set of registered providers, and the router only sees a
 * tenant's slice.
 *
 * Isolation model:
 *   - Isolation across tenants is enforced here (not by after-the-fact
 *     policy filtering).
 *   - A deployment either (a) runs one Kindgi instance per tenant
 *     with its own set of registered providers, or (b) runs a shared
 *     instance where the framework registers per-tenant provider
 *     entries — same adapter binary, different keys per tenant (each
 *     provider closes over that tenant's secrets).
 *   - `TenantPolicy` still narrows the visible set at routing time
 *     (allow/deny lists, cost caps, region gates) — that stays
 *     orthogonal to tenant isolation.
 *
 * This aligns with the storage-side `ProviderRegistryBinding` (in
 * `@kindgi/api`), whose methods all take `tenantId`. A registry backed
 * by that storage reads persisted provider metadata and instantiates
 * providers through an `AdapterFactoryRegistry`.
 */
export interface ProviderRegistry {
  register(tenantId: TenantId, provider: ModelProvider): void;
  get(tenantId: TenantId, id: string): ModelProvider | undefined;
  list(tenantId: TenantId): readonly ModelProvider[];
  has(tenantId: TenantId, id: string): boolean;
  /**
   * Optional async warm-up. Storage-backed implementations
   * hydrate their per-tenant instance cache from the persistent
   * `ProviderRegistryBinding` on the first call for a given tenant;
   * the agent runtime awaits this before the sync `list(tenantId)` call
   * so the router sees the full set. In-memory implementations that
   * hold their state eagerly leave this undefined, and callers skip it.
   *
   * Idempotent: hydrating an already-hydrated tenant returns
   * immediately.
   */
  hydrate?(tenantId: TenantId): Promise<void>;
  /**
   * Optional cache invalidation. Storage-backed implementations call
   * this from the provider write path (register, unregister) so the
   * next `hydrate(tenantId)` re-reads from the persistent store.
   * Without it, a provider registered after boot is persisted but the
   * cache keeps serving the providers loaded at boot. In-memory
   * implementations leave it undefined — no cache to invalidate.
   */
  invalidate?(tenantId: TenantId): void;
}

/**
 * Per-tenant policy the router honors on top of the capability
 * declaration. Every field optional; empty policy = "no additional
 * constraints."
 *
 * `providers.allow` is a positive list of provider ids; if present,
 * only listed providers are eligible — an empty list allows none.
 * `providers.deny` excludes. `models.allow` / `models.deny` do the same
 * at the model level (e.g. "tenant may use anthropic but not opus").
 * Deny wins over allow where the two overlap at either level.
 *
 * `regionAllow` narrows to specific provider regions; an empty list
 * allows none.
 * `maxCostPerCallUsd` caps per-invocation cost using the picked
 * model's `promptUsdPer1kTokens` as the cheap proxy.
 * `maxTokensPerCall` caps the picked model's context window.
 */
export interface TenantPolicy {
  readonly tenantId: TenantId;
  readonly providers?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  readonly models?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  readonly regionAllow?: readonly string[];
  readonly maxCostPerCallUsd?: number;
  readonly maxTokensPerCall?: number;
}

/** A `(provider, model)` tuple as picked by the router. */
export interface ProviderModelPick {
  readonly provider: ModelProvider;
  readonly model: ModelInfo;
}

/**
 * The router's decision output. Returns a `(provider, model)` tuple —
 * the picked connection AND the picked model within it. Callers thread
 * `ModelCallInput.model = decision.model.name` when invoking
 * `provider.invoke`.
 */
export interface RoutingDecision {
  readonly provider: ModelProvider;
  readonly model: ModelInfo;
  readonly reason: string;
  /**
   * Alternate tuples in ranked order. Useful for failover — if the top
   * pick throws or hits a rate limit, the caller can retry with the
   * next.
   */
  readonly alternates: readonly ProviderModelPick[];
  /**
   * `true` when only fallback providers (`ProviderMetadata.fallback`)
   * satisfy the capability, so the pick is one of them.
   */
  readonly fallback: boolean;
}
