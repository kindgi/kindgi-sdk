// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Logger } from '@kindgi/log';
import type { ZodLikeSchema } from '@kindgi/schema';
import type { OrgId, ProjectId, TenantId, ToolId, UserId } from '@kindgi/types';

/**
 * JSON Schema for a tool's input/output. Author-supplied, Draft 2020-12.
 * Kept as `unknown` here — the loader validates that the provided value is
 * a legal Ajv schema at `defineTool` time.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Closed set of effect kinds Kindgi recognises. Matches @kindgi/specs/tool.schema.json. */
export const EFFECT_KINDS = [
  'reads',
  'writes',
  'deletes',
  'network',
  'spawns-run',
  'emits-event',
  'external-side-effect',
  'sensitive-data-egress',
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

/**
 * A declared side-effect. Enables policy enforcement (can this tool run in
 * this tenant?), safe parallelization (are two invocations conflicting?),
 * and causal provenance annotation.
 */
export interface Effect {
  readonly kind: EffectKind;
  /**
   * Resource identifier the effect targets — for example `memory:facts`,
   * `blob:*`, `external:api.example.com`. Opaque to this package; the
   * policy engine interprets it when enforcing tenant policy.
   */
  readonly resource?: string;
  readonly notes?: string;
}

/**
 * A typed context requirement — a named slot the tool expects the runtime
 * to supply. The name matches an entry in the tenant's provider registry
 * (`tenant`, `db`, `memory:facts`, `blob`, etc.). Not enforced by this
 * package; declarative metadata for capability + policy layers.
 */
export interface Need {
  readonly name: string;
  readonly optional?: boolean;
}

/**
 * The transport-neutral context a tool receives at invocation. Whether the
 * tool is called from a kernel run (in-process) or over MCP (remote), the
 * caller synthesises a `ToolContext` and passes it in.
 *
 * Deliberately narrow — kernel-specific things like the journal or
 * NodeContext helpers stay on the kernel side of the bridge.
 */
export interface ToolContext {
  /**
   * Tenant scope for the invocation. Every tool call is tenant-scoped;
   * cross-tenant access is denied by policy at the kernel layer.
   * Handlers use this to key persistence (per-tenant DBs, per-tenant
   * blob buckets) and to route capability calls (secrets scoped to
   * this tenant only).
   */
  readonly tenantId: TenantId;
  /**
   * The acting principal, if the runtime can identify one. Optional
   * because some invocations (scheduled background jobs) are system-run.
   */
  readonly principal?: UserId;
  /**
   * The kernel run the call belongs to, when a run invokes the tool — an
   * agent turn or a flow step. Stable across every call the run makes.
   */
  readonly runId?: string;
  /**
   * The project of the run the call belongs to. The runtime sets it from
   * the run, never from the run's input or a model's arguments, so a tool
   * can check an id in its input against it. Absent outside a run (a unit
   * test passes its own).
   */
  readonly projectId?: ProjectId;
  /**
   * The org of that project, when the project belongs to one. The runtime
   * sets it from the project, never from input. Absent when the project
   * has no org, and outside a run.
   */
  readonly orgId?: OrgId;
  /**
   * Correlation id for this individual call (the model's tool-call id,
   * an MCP request id, a webhook id). Opaque to tools; useful for logs,
   * provenance and idempotency.
   */
  readonly requestId?: string;
  /**
   * Signal that fires when the caller wants the tool to abort — kernel
   * cancel/failure teardown, MCP client disconnect, HTTP request cancel.
   * Cooperative handlers should observe this and exit early.
   */
  readonly abortSignal: AbortSignal;
  /**
   * Optional secret resolver. HTTP tools built via
   * `defineTool({spec: {kind: 'http', ...}})` uses this at invoke time to resolve its
   * declared `secret_ref`s to plaintext credentials. Absent → HTTP
   * tools that declare a `secret_ref` throw with a clear
   * "resolveSecret not wired" error; tools that don't need secrets
   * (dev-echo, in-process handlers) ignore it.
   *
   * Caller responsibility: the dispatch site (the agent turn's
   * `dispatch-tools` step in `@kindgi/agents`, a flow node that runs
   * the tool, an MCP server) populates this from the deployment's
   * `SecretBinding` scoped to the invoking tenant.
   */
  readonly resolveSecret?: (ref: ToolSecretRef) => Promise<string>;
  /**
   * A logger bound to this call: its records carry the run's ids and the
   * caller's trace id (`ctx.log.info('looked up order', { orderId })`).
   * The pack service sets it; a caller that synthesises a context may
   * not, so write `ctx.log?.info(…)` in code that also runs elsewhere. A
   * secret's value is never a field (the logger redacts secret-looking
   * keys and shapes, but don't rely on it).
   */
  readonly log?: Logger;
  /**
   * The values of the settings blocks the calling agent version pins, by
   * block id (`ctx.settings['acme.weights'].recency`). Unset when the
   * agent references none. A tool reads its tunables here, so an expert
   * changes them by publishing a new block version, not new code.
   */
  readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * The secrets this tool declares in `needsSpec.secrets`, by name,
   * resolved by the runtime for this call: for the call's tenant, in the
   * env the runtime serves (`KINDGI_ENV`; in `kindgi dev`, `local` — the
   * pack's `.env` and `.env.local`). Every declared name is present: one
   * the runtime can't resolve, or whose value doesn't match its schema,
   * fails the call before the handler runs. Absent when the tool
   * declares none, and wherever nothing resolves them — a unit test
   * passes its own.
   */
  readonly secrets?: Readonly<Record<string, string>>;
}

/**
 * Pointer to a tenant-scoped secret used by a declarative tool
 * (e.g. `{kind: 'http'}` with a bearer secretRef). Same shape as
 * `ProviderSecretRef` in `@kindgi/api` — both are `{envName, name}`
 * references resolved via the deployment's `SecretBinding`. Kept
 * local to `@kindgi/tools` so the tools package doesn't take an
 * api-layer dep.
 */
export interface ToolSecretRef {
  readonly envName: string;
  readonly name: string;
}

/**
 * Isolation posture the runtime enforces around the handler. Three tiers:
 *   - `'none'`              — no isolation. First-party framework handlers
 *                             only; registration rejects tenant-authored
 *                             tools declaring `'none'`.
 *   - `'context-isolated'`  — same-process `node:vm` context. NOT a
 *                             security boundary; prevents accidental state
 *                             bleed.
 *   - `'strict'`            — real container / MicroVM isolation. Required
 *                             for anything running untrusted code.
 *
 * Sandbox declaration + capability manifest = the handler's declared
 * capability contract.
 */
export type SandboxMode = 'none' | 'context-isolated' | 'strict';

/**
 * Runtime resource caps enforced by the sandbox layer at dispatch. Wall-
 * clock (`wallMs`) intentionally NOT here — it belongs on the incoming
 * edge as `EdgePolicy.timeoutMs`.
 */
export interface RuntimeLimits {
  readonly memMB: number;
  readonly cpuMs: number;
}

/**
 * Network egress policy for the sandboxed handler. Discriminated on
 * `kind`; `allowlist` carries the explicit host list, the other two are
 * unary.
 */
export type NetworkPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'allowlist'; readonly hosts: readonly string[] }
  | { readonly kind: 'unrestricted' };

/**
 * Typed dependency declarations for handler code, carried on the
 * manifest as `needsSpec`. Each slot is optional; a handler that
 * consumes none of a slot omits it entirely.
 *
 * In this shape (the serialisable projection carried in `index.json`
 * and over the wire) values in `env` / `secrets` / `config` are JSON
 * Schemas. An authoring tool that accepts Zod converts with
 * `z.toJSONSchema()` before the manifest is built.
 *
 * `capabilities` names capability-router features (e.g. `'embedding'`);
 * `bindings` names deployment-plugged binding keys (e.g. `'blob'`).
 *
 * The manifest field is `needsSpec` because `needs` holds the flat
 * `Need[]` list of named context slots; both fields exist side by side.
 */
export interface TypedNeeds {
  readonly env?: Readonly<Record<string, JsonSchema>>;
  readonly secrets?: Readonly<Record<string, JsonSchema>>;
  readonly config?: Readonly<Record<string, JsonSchema>>;
  readonly capabilities?: readonly string[];
  readonly bindings?: readonly string[];
}

/**
 * Handler-artifact pointer. Discriminated on `kind`:
 *
 * - `'oci'`         — production. Populated by the deploy pipeline
 *                     once the image is built
 *                     + signed. `modulePath` resolves inside the pinned
 *                     `imageRef`. `artifactVersion` is the auto-assigned
 *                     `YYYYMMDD.N` version pinning one deploy (distinct
 *                     from `ToolManifest.version` — semver, pack-authored).
 * - `'filesystem'`  — dev-mode. Populated by local development tooling
 *                     at registration time. `modulePath` is an
 *                     absolute host filesystem path pointing at the
 *                     pack's on-disk handler file. Production
 *                     deployments SHOULD reject this variant — the
 *                     substrate is dev-only.
 *
 * Absent on framework-owned in-process manifests.
 */
export type CodeArtifactRef =
  | {
      readonly kind: 'oci';
      readonly imageRef: string;
      readonly modulePath: string;
      readonly artifactVersion: string;
    }
  | {
      readonly kind: 'filesystem';
      readonly modulePath: string;
    };

/**
 * The serialisable projection of a tool — everything except the runtime
 * handler binding. Matches `@kindgi/specs/tool.schema.json` and round-trips over
 * the wire. This is what MCP and cross-runtime discovery consume.
 *
 * ## Additive extensions
 *
 * `sandbox`, `limits`, `network`, `needsSpec`, `codeArtifactRef` are
 * optional extensions that the dispatch, SDK and deploy layers
 * populate + honor. Registrations that don't set them leave them
 * undefined; consumers that don't know about them ignore the fields.
 */
export interface ToolManifest {
  /**
   * Globally-unique tool identifier. Convention: `<pack-id>.<tool-name>`
   * (kebab-case, dot-namespaced) — e.g. `acme.verify-citation`,
   * `demo.echo`. The `<pack-id>` prefix scopes the tool to its pack;
   * `<tool-name>` names the operation. Enforced as a `ToolId` brand;
   * `defineTool` refuses ids that don't match the convention.
   */
  readonly id: ToolId;
  /**
   * Human-readable one-liner describing what the tool does. Surfaced
   * to the model as part of the tool definition (`ModelToolDefinition.description`)
   * — the model uses it to decide when to call. Write it for the
   * model: what the tool DOES, what it RETURNS, and when to prefer
   * it over other tools. Skip implementation details.
   */
  readonly description: string;
  /**
   * Semver — REQUIRED. Every tool registered in a Kindgi deployment
   * ships versioned; an agent's `tools[].version` is a semver range
   * matched against these versions at dispatch time via
   * `semver.maxSatisfying`. Enforced by
   * `defineTool(...)` at the API boundary.
   */
  readonly version: string;
  /**
   * JSON Schema Draft 2020-12 for the tool's input. Handed to the
   * model as the tool's parameter schema so it can generate valid
   * calls. `invokeTool` validates every incoming input against this
   * before invoking the handler — invalid input surfaces as a
   * `bad-input` error, never reaches the handler.
   *
   * Zod authors: pass a Zod v4 schema to `defineTool({input: zSchema})`;
   * the framework converts to JSON Schema at author time and preserves
   * the Zod schema on `tool.inputZod` for TS-side inference.
   */
  readonly input: JsonSchema;
  /**
   * JSON Schema Draft 2020-12 for the tool's output. `invokeTool`
   * validates the handler's return value against this before surfacing
   * it — a handler that returns off-schema fails with
   * `bad-output`. Same Zod-conversion story as `input`.
   *
   * Prefer explicit schemas over `type: 'object', additionalProperties: true`
   * — the model uses the output schema to interpret tool results
   * downstream.
   */
  readonly output: JsonSchema;
  /**
   * Named context slots the tool depends on (e.g. `tenant`, `run`,
   * `blob`, `memory:facts`). Framework-level dependencies the tool
   * expects the runtime to inject via `ToolContext`. Declarative: not
   * checked when a flow is loaded. `needsSpec` is the typed,
   * discriminated form (env / secrets / config / capabilities /
   * bindings).
   */
  readonly needs?: readonly Need[];
  /**
   * Declared side-effects the tool causes — an `EFFECT_KINDS` kind
   * (`writes`, `network`, `external-side-effect`, …), optionally with
   * the `resource` it targets. Consumed by policy + audit machinery for
   * effect-based gating (e.g. "block any tool with an
   * `external-side-effect` in a dry-run"). Distinct from `mutating` —
   * `effects` names WHICH effects; `mutating` is a coarser boolean.
   */
  readonly effects?: readonly Effect[];
  /**
   * How the tool is dispatched at invoke time. `'native'` (default)
   * uses the framework's in-process dispatch; `'mcp'` routes through
   * the Model Context Protocol endpoint declared at `mcpEndpoint`;
   * `'auto'` picks native if a handler exists, else mcp. Most
   * pack-authored tools omit this and default to native.
   */
  readonly transport?: 'auto' | 'native' | 'mcp';
  /**
   * MCP server URL for `transport: 'mcp'` tools. Ignored when
   * transport is native. See the Model Context Protocol spec for the
   * expected endpoint shape.
   */
  readonly mcpEndpoint?: string;
  /**
   * Free-form key/value metadata that rides along with the manifest.
   * Not interpreted by the framework — passthrough for pack-authored
   * annotations (e.g. `{owner: 'team-legal', ticket: 'PROJ-123'}`).
   * Surfaced in `GET /v1/tools/:id` responses for tooling.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Semantic marker: `true` when this tool causes observable side
   * effects (writes state, calls external APIs with mutations, sends
   * messages, etc.). Read-only tools (queries, computations, retrievals)
   * set `false`. Absent = defaults to `true` (safer — the framework's
   * `never_ask / ask_on_first_use / always_ask` policy defaults hinge
   * on this flag; mistakenly marking a mutating tool as read-only would
   * bypass HITL, while the reverse only adds friction).
   *
   * Consumed by `@kindgi/agents` as the per-tool HITL default when an
   * agent's `conversationPolicy.hitl.tools` sets neither an override
   * nor a `default` for the tool — a read-only tool passes straight
   * through, a mutating tool asks on first use.
   */
  readonly mutating?: boolean;
  /** Isolation posture — see `SandboxMode`. */
  readonly sandbox?: SandboxMode;
  /** Memory + CPU caps enforced by the sandbox at dispatch. */
  readonly limits?: RuntimeLimits;
  /** Network egress policy the sandbox honors. */
  readonly network?: NetworkPolicy;
  /**
   * Discriminated typed-dependency declarations (env / secrets / config /
   * capabilities / bindings). See `TypedNeeds` for the shape.
   */
  readonly needsSpec?: TypedNeeds;
  /**
   * Signed pointer at the deploy-time OCI image + module path carrying
   * the handler bytes. Absent for in-process manifests.
   */
  readonly codeArtifactRef?: CodeArtifactRef;
  /**
   * Declarative handler specification. When present, the runtime
   * `Tool.handler` is synthesized from this spec — the manifest
   * carries everything needed for a first-party framework
   * synthesizer to build the fetch/query/dispatch call at register
   * time. Author writes the spec; framework owns the correctness
   * bits (timeouts, aborts, secret resolution, retries).
   *
   * Discriminated on `spec.kind`. The framework ships `'http'` (see
   * `HttpToolSpec`) as the first-party kind; other kinds plug in via
   * `registerToolSpecSynthesizer`.
   *
   * `spec` and `handler` are MUTUALLY EXCLUSIVE at `defineTool` time
   * — a tool is either declarative or imperative. Mixed usage
   * fails to compile.
   *
   * The full JSON-serializable manifest (spec included) is what
   * `POST /v1/tools` accepts — declarative tools can be registered
   * from configuration without shipping code.
   */
  readonly spec?: ToolSpec;
}

/**
 * Union of all declarative handler specifications the framework
 * synthesizes into runtime handlers. Discriminated on `kind`; `'http'`
 * is the only kind in this union. Adding a kind does not change the
 * `defineTool({ spec })` author surface.
 */
export type ToolSpec = HttpToolSpec;

/**
 * Declarative HTTP-invocation spec. All fields serialize cleanly to
 * JSON — no runtime closures. Credentials appear ONLY as
 * `secret_ref` pointers; the actual plaintext is resolved at invoke
 * time via `ToolContext.resolveSecret`.
 */
export interface HttpToolSpec {
  /**
   * Discriminant. Every declarative tool spec self-identifies via
   * `kind` so the framework's synthesizer registry can route to the
   * right handler builder.
   */
  readonly kind: 'http';
  /**
   * HTTP method. `GET` and `DELETE` typically carry no body;
   * `POST`, `PUT`, `PATCH` typically do. The default body shape is
   * `json-input` (see `requestBody`).
   */
  readonly method: HttpMethod;
  /**
   * URL template with `{param}` placeholders substituted from the
   * tool's input at invoke time. Example:
   * `https://api.github.com/repos/{owner}/{repo}/issues/{number}`.
   * Every placeholder must correspond to an input property; missing
   * substitutions surface as a `handler-error` at invoke time.
   */
  readonly urlTemplate: string;
  /**
   * Static or templated headers. Values may include `{param}`
   * placeholders substituted from the tool's input (e.g.
   * `X-Trace-Id: {requestId}`). For credentialed headers use
   * `authorization` — it keeps secret references out of `headers`.
   */
  readonly headers?: readonly HttpHeaderSpec[];
  /**
   * Optional authentication injected as a header on the outbound
   * request. Union kinds:
   *   - `bearer`  — writes `Authorization: Bearer <secret>` where
   *                 `<secret>` is the plaintext of `secret_ref`.
   *   - `header`  — writes `<headerName>: <secret>` verbatim (for
   *                 vendors that use a non-`Authorization` header,
   *                 e.g. `X-API-Key`).
   */
  readonly authorization?: HttpAuthSpec;
  /**
   * Request-body specification for methods that carry a body
   * (`POST`, `PUT`, `PATCH`, `DELETE`). Absent → no body sent.
   *
   * The default body strategy is `{kind: 'json-input'}` — the tool's
   * INPUT (after URL-template substitution consumes its keys) is
   * JSON-serialized as the body. `input-passthrough` sends the raw
   * input object (JSON body) without URL-consuming any keys, so
   * keys used in the URL template appear redundantly in the body
   * too. Choose based on the target API's expected shape.
   */
  readonly requestBody?: HttpRequestBodySpec;
  /**
   * Wall-clock timeout in milliseconds. Enforced via AbortController.
   * Defaults to 30_000 (30s) when absent — matches typical vendor
   * SLOs.
   */
  readonly timeoutMs?: number;
  /**
   * When the response body should be parsed as JSON before returning
   * to the invoker. Default: `true`. Set `false` for adapters that
   * hand-parse (rare) or for text-only endpoints.
   */
  readonly parseJson?: boolean;
  /**
   * Acceptable status-code range. Responses outside this range are
   * treated as `handler-error` with the response text as the message.
   * Default: `[200, 299]` (any 2xx).
   */
  readonly successStatus?: {
    readonly min: number;
    readonly max: number;
  };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpHeaderSpec {
  readonly name: string;
  readonly value: string;
}

export type HttpAuthSpec =
  | {
      readonly kind: 'bearer';
      readonly secretRef: ToolSecretRef;
    }
  | {
      readonly kind: 'header';
      readonly headerName: string;
      readonly secretRef: ToolSecretRef;
    };

export type HttpRequestBodySpec =
  | { readonly kind: 'json-input' }
  | { readonly kind: 'input-passthrough' }
  | { readonly kind: 'text'; readonly template: string };

/**
 * The runtime object: manifest + local handler. Only exists in-process;
 * `handler` is stripped when the tool is projected to a manifest for
 * serialisation, MCP exposure, or discovery.
 *
 * Type parameters are caller-asserted — the runtime validates against
 * `input` / `output` JSON Schema, not the TS type — but let authors write
 * typed handlers when they know the shape.
 */
export interface Tool<TInput = unknown, TOutput = unknown> extends ToolManifest {
  /**
   * The runtime handler — the function `invokeTool` actually calls.
   * Types are caller-asserted (matches the `defineTool` generics);
   * the runtime validates against `input` / `output` JSON Schema at
   * every invocation, not the TS type.
   */
  readonly handler: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
  /**
   * The original Zod schema, preserved when the tool was authored with a
   * Zod v4 schema at the `input` slot. Present iff the author passed a
   * Zod schema to `defineTool`; otherwise `undefined`. Wire form is
   * always the converted JSON Schema on `input` — this field exists so
   * TS callers can `z.infer<typeof tool.inputZod>` for static types.
   *
   * Explicitly `ZodLikeSchema | undefined` (not a bare optional marker):
   * the more specific `DefinedTool<TInSchema, TOutSchema>` returned by
   * `defineTool` narrows this to the exact Zod schema type when Zod is
   * used, and to `undefined` when JSON Schema is used. Consumers reading
   * a heterogeneous `AnyTool` see the union and narrow with `!== undefined`.
   */
  readonly inputZod?: ZodLikeSchema | undefined;
  /** Symmetric to `inputZod` for the `output` slot. */
  readonly outputZod?: ZodLikeSchema | undefined;
}

/**
 * Type-erased alias for cross-boundary storage (registries, arrays of mixed
 * tools). Handlers are contravariant in their input type, so a
 * `Tool<{ text: string }, ...>` is not assignable to `Tool<unknown, unknown>`
 * — this alias uses `unknown` on both sides so heterogeneous collections
 * type-check without lying about the runtime shape.
 */
// biome-ignore lint/suspicious/noExplicitAny: covariance boundary for heterogeneous storage
export type AnyTool = Tool<any, any>;

/** MCP-compatible tool manifest. Narrower shape than `ToolManifest`. */
export interface McpToolManifest {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
}
