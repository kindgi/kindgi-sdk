// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the adapter catalog — part of the admin
 * control plane. Read-only + smoke-test-only
 * over HTTP: tenants + operators see every adapter the deployment
 * wired at boot time and probe each one for liveness.
 *
 * Adapters are the concrete bridges the runtime uses to talk to
 * outside systems: model providers, embedding providers, blob storage,
 * sandbox providers, eval judges. Each adapter package
 * (the filesystem blob adapter, the inprocess sandbox adapter,
 * `@kindgi/adapter-model-in-process`, `@kindgi/adapter-model-openai-compat`,
 * the local embedding adapter, the AJV eval-judge adapter, ...)
 * exports a factory + optional metadata; the deployment aggregates the
 * ones it actually wired into an `AdapterRegistryBinding`.
 *
 * ## Why read-only + test-only
 *
 * Adapter lifecycle (register / unregister / reconfigure) is a
 * **deployment concern**, not a runtime one. The runtime learns about
 * adapters at `CreateAppInput` time; if a deployment wants to change
 * what's wired it restarts the process with different config. This
 * mirrors the pattern used elsewhere in the framework where lifecycle
 * state is deployment-owned (bucket allocation in S3, key store for
 * signing). HTTP-driven adapter reconfigure would require the runtime
 * to accept live reconfiguration, which it does not.
 *
 * ## Wire shape discipline
 *
 * `AdapterInfo.config` is REDACTED — no secrets on the wire. A binding
 * MAY expose non-sensitive routing hints (`{ region: 'us-east-1' }`)
 * but MUST NOT surface API keys, endpoints, credentials, or any
 * material that could be used to impersonate the adapter. The binding
 * is authoritative on what counts as safe to expose per adapter kind.
 *
 * ## Probe semantics
 *
 * `test(...)` runs a kind-specific smoke probe against the adapter.
 * Probe failures return an `AdapterTestOutcome` with `ok: false` — not
 * an error. A failed probe is a valid observation about the adapter's
 * state, not a server error. The route surfaces `AdapterTestOutcome`
 * as HTTP 200 either way; a 5xx would indicate the probe machinery
 * itself broke (which is legitimately a server error).
 *
 * ### Default probes by adapter kind
 *
 *  - `blob`: write 32 random bytes → read back → verify hash → delete.
 *  - `sandbox`: create a context-isolated (or `none`) sandbox → run
 *    `1 + 1 === 2` → verify result → destroy.
 *  - `model` / `model-provider`: minimal completion with
 *    `[{ role: 'user', content: 'ping' }]` and `maxTokens: 1` — verify
 *    the provider returns a well-shaped response.
 *  - `embedding`: embed the string `'ping'` — verify the vector length
 *    matches the advertised dimension.
 *  - `eval-judge`: run a trivial pass-through eval — verify success.
 *
 * Adapter authors MAY accept a caller-supplied `input` on `test(...)`
 * for more elaborate probes; when absent the binding falls back to
 * the default above.
 *
 * Every method is tenant-scoped. Cursors are opaque — the binding
 * chooses its encoding. The API layer only validates round-trip as a
 * string; it never inspects the payload.
 */
export interface AdapterRegistryBinding {
  /**
   * Cursor-paginated list of adapters the deployment has wired.
   * Optional filters narrow to a specific `kind` or `status`.
   */
  list(input: AdapterListInput): Promise<AdapterPage>;
  /**
   * Fetch a single adapter by id, or `null` when unknown. The route
   * surfaces `null` as `404 adapter-not-found`.
   */
  get(input: AdapterGetInput): Promise<AdapterInfo | null>;
  /**
   * Run the kind-specific smoke probe. Returns `null` when the id is
   * unknown — the route surfaces that as `404 adapter-not-found`.
   * Otherwise returns an `AdapterTestOutcome` (which itself carries
   * `ok: true | false` — failed probes are data, not errors).
   */
  test(input: AdapterTestInput): Promise<AdapterTestOutcome | null>;
}

/**
 * Closed set of adapter kinds the framework knows about. New kinds
 * require an additive schema update — we enumerate rather than accept
 * an open string so wire consumers (UIs, command-line tools) can render
 * kind-specific columns without guessing.
 *
 * `model-provider` is distinct from `model` for adapters that wrap a
 * remote provider gateway (a hosted API or a self-hosted inference
 * server) vs. adapters that host the model in-process.
 */
export type AdapterKind =
  | 'model'
  | 'model-provider'
  | 'embedding'
  | 'blob'
  | 'sandbox'
  | 'eval-judge';

export const ADAPTER_KINDS: readonly AdapterKind[] = [
  'model',
  'model-provider',
  'embedding',
  'blob',
  'sandbox',
  'eval-judge',
];

/**
 * Adapter status the wire surface exposes. `active` = wired and
 * last-observed healthy. `degraded` = wired but the binding has seen
 * recent failures / partial capability loss. `error` = wired but
 * unusable (e.g. auth material missing at boot). The binding is
 * authoritative on how it derives the value.
 */
export type AdapterStatus = 'active' | 'degraded' | 'error';

export const ADAPTER_STATUSES: readonly AdapterStatus[] = ['active', 'degraded', 'error'];

/**
 * Wire shape for a single wired adapter. Deployments produce this
 * from whatever data structure they use to hold their adapter set —
 * commonly the `describe()` output on the adapter factory plus a
 * status field the deployment tracks itself.
 */
export interface AdapterInfo {
  /** Stable id chosen by the deployment (e.g. `'sandbox-primary'`). */
  readonly adapterId: string;
  readonly kind: AdapterKind;
  /** Package name that owns the implementation (e.g. `'@kindgi/adapter-model-in-process'`). */
  readonly name: string;
  /** Semver of the wired package. */
  readonly version: string;
  /**
   * Kind-specific capability tags. Free-form strings scoped by kind —
   * e.g. `['context-isolated']` for a sandbox adapter, `['tool-use', 'streaming']`
   * for a model adapter, `['multipart-upload']` for blob storage.
   */
  readonly capabilities: readonly string[];
  /**
   * Redacted routing hints only. No secrets. Absent when the binding
   * has nothing safe to expose.
   */
  readonly config?: Readonly<Record<string, unknown>>;
  readonly status: AdapterStatus;
  /** Human-readable reason accompanying `degraded` / `error` status. */
  readonly statusReason?: string;
}

export interface AdapterListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly filter?: AdapterListFilter;
}

export interface AdapterListFilter {
  readonly kind?: AdapterKind;
  readonly status?: AdapterStatus;
}

export interface AdapterPage {
  readonly data: readonly AdapterInfo[];
  readonly nextCursor?: Cursor;
}

export interface AdapterGetInput {
  readonly tenantId: TenantId;
  readonly adapterId: string;
}

export interface AdapterTestInput {
  readonly tenantId: TenantId;
  readonly adapterId: string;
  /**
   * Optional kind-specific probe input. When absent the binding runs
   * the default probe documented in the interface JSDoc above. Shape
   * is intentionally open so bindings can extend the probe surface
   * per kind without a schema change.
   */
  readonly input?: Readonly<Record<string, unknown>>;
}

/**
 * Result of a probe run. `ok: false` is a valid observation — the
 * route serialises it as HTTP 200 either way.
 *
 * `probe` is kind-specific data (e.g. `{ vectorLength: 384 }` for an
 * embedding probe, `{ latencyMs: 42, completion: '2' }` for a model
 * probe). Consumers should not depend on its exact shape — the UI
 * treats it as a diagnostic bag to render as JSON.
 */
export interface AdapterTestOutcome {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly probe: Readonly<Record<string, unknown>>;
}
