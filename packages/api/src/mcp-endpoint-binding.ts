// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TupleEnqueueHook } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the MCP-endpoint catalog. Tenants register
 * the remote MCP servers they want the runtime to consume. At boot the
 * runtime discovers each endpoint's tools (MCP `tools/list`) and
 * registers them into the `ToolRegistryBinding` under the same tenant —
 * remote tools become native `Tool`s without a TypeScript recompile.
 *
 * Contract shape: 4-method non-versioned, mirroring
 * `ProviderRegistryBinding` (`list` / `get` / `register` / `unregister`)
 * minus `capabilitiesFor` — an MCP endpoint doesn't advertise a static
 * capability list up-front (tools come from the live server at boot).
 *
 * Every method is tenant-scoped: callers pass `tenantId` explicitly so
 * multi-tenant deployments can partition storage without exposing the
 * scoping inside the API package.
 *
 * **Wire-safety of secrets.** `authRef` is a REFERENCE (e.g.
 * `env:MY_MCP_KEY`), never a plaintext credential. The API surface
 * accepts, stores, and returns only the reference; the runtime resolves
 * it inside the deployment (e.g. against env vars) before constructing
 * the transport. This mirrors the "no secrets on
 * the wire" guardrail `ProviderRegistryBinding` enforces for LLM keys.
 */
export interface MCPEndpointRegistryBinding {
  /** Cursor-paginated list. Optional `transportFilter` narrows to one variant. */
  list(input: MCPEndpointListInput): Promise<MCPEndpointPage>;
  /** Fetch a single endpoint, or `null` when unknown. Route flips `null` → 404. */
  get(input: MCPEndpointGetInput): Promise<MCPEndpoint | null>;
  /**
   * Register an endpoint. Route validates the closed transport enum and
   * the config-transport ↔ top-level-transport match before calling.
   * Bindings MAY reject with `already-registered`; the route maps that
   * to `409 mcp-endpoint-already-registered`.
   */
  register(input: MCPEndpointRegisterInput): Promise<MCPEndpointRegisterOutcome>;
  /**
   * Remove an endpoint. `{ unregistered: false }` maps to
   * `404 mcp-endpoint-not-found` at the route.
   */
  unregister(input: MCPEndpointUnregisterInput): Promise<MCPEndpointUnregisterOutcome>;
}

/**
 * Closed transport enum. `stdio` for local subprocess servers,
 * `http-sse` for the older MCP HTTP+SSE transport (separate SSE stream
 * + POST endpoint), `streamable-http` for the Streamable HTTP transport
 * (single HTTP endpoint, SSE for server → client, POST for
 * client → server, session-id via header). Additive: extend the
 * union when a new SDK transport lands.
 */
export const MCP_TRANSPORTS = ['stdio', 'http-sse', 'streamable-http'] as const;
export type MCPTransport = (typeof MCP_TRANSPORTS)[number];

/** stdio transport config — subprocess command + args. */
export interface MCPStdioConfig {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** http-sse transport config — HTTP+SSE transport (separate SSE + POST). */
export interface MCPHttpSseConfig {
  readonly transport: 'http-sse';
  readonly url: string;
  /** Optional distinct SSE endpoint if the server splits them. */
  readonly sseUrl?: string;
  /** Optional header overrides. `secretRef` is applied separately by the runtime. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** streamable-http transport config — single endpoint. */
export interface MCPStreamableHttpConfig {
  readonly transport: 'streamable-http';
  readonly url: string;
  /** Optional header overrides. `secretRef` is applied separately by the runtime. */
  readonly headers?: Readonly<Record<string, string>>;
}

export type MCPEndpointConfig = MCPStdioConfig | MCPHttpSseConfig | MCPStreamableHttpConfig;

/**
 * The secret an endpoint authenticates with: a name in the deployment's
 * secrets store, resolved at the endpoint's tenant scope (the shape
 * webhooks and providers use). Never the secret itself.
 */
export interface MCPEndpointSecretRef {
  readonly envName: EnvName;
  readonly name: string;
}

/**
 * Wire shape for a registered MCP endpoint. Secrets never appear —
 * `secretRef` names a secret the runtime resolves inside the
 * deployment. Callers who inspect this object over the wire never see
 * the plaintext credential.
 */
export interface MCPEndpoint {
  /** Deployment-stable endpoint id. Route param + registration key. */
  readonly endpointId: string;
  /** Human-readable display name. */
  readonly name: string;
  /**
   * Redundant with `config.transport` — kept at the top for cheap
   * filtering (`?transport=stdio`) without unwrapping `config`. Route
   * enforces `config.transport === transport` at registration.
   */
  readonly transport: MCPTransport;
  readonly config: MCPEndpointConfig;
  /**
   * The secret sent as the endpoint's bearer (`Authorization` by default),
   * resolved through the tenant's secrets store when the runtime connects.
   */
  readonly secretRef?: MCPEndpointSecretRef;
  /**
   * Optional pass-through to the MCP client's server-info instructions
   * slot. Purely informational.
   */
  readonly instructions?: string;
  /** Optional caller-defined metadata bag. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MCPEndpointListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Exact match on `transport`. */
  readonly transportFilter?: MCPTransport;
  /**
   * Narrow the list to a specific scope. Absent = no narrow (return
   * every row in the tenant regardless of scope kind).
   *
   * Policy/config-scoped semantics (this binding):
   * - `{ kind: 'project', projectId }` — with `inherit=true` (default):
   *   rows literally at this project + rows at the project's org +
   *   tenant-wide rows (upward walk). With `inherit=false`: only rows
   *   registered at exactly this project.
   * - `{ kind: 'org', orgId }` — with `inherit=true`: org-scoped +
   *   tenant-scoped. With `inherit=false`: only rows registered at
   *   exactly this org.
   * - `{ kind: 'tenant', tenantId }` — `inherit` has no effect (already
   *   the top of the hierarchy).
   */
  readonly scope?: Scope;
  /**
   * `true` (default) = inheritance walk. Matches the common
   * user-facing case ("what endpoints does this project see").
   * `false` = literal-at-this-scope only. Matches the admin/audit case
   * ("what's explicitly configured at this scope").
   */
  readonly inherit?: boolean;
}

export interface MCPEndpointGetInput {
  readonly tenantId: TenantId;
  readonly endpointId: string;
}

export interface MCPEndpointRegisterInput {
  readonly tenantId: TenantId;
  readonly endpoint: MCPEndpoint;
  /**
   * Scope at which the endpoint is registered (policy/config anchor).
   * Required — no silent tenant-scope fallback at the binding layer.
   * Callers without a natural scope resolve via
   * `bindings.projectBinding.getDefault(...)` at the caller layer (route
   * body, runtime).
   *
   * Policy/config-scoped semantics (this binding):
   * - `{ kind: 'project', projectId }` — endpoint visible only to that
   *   project and its descendants under inherit=true reads.
   * - `{ kind: 'org', orgId }` — visible to every project inside that org
   *   under inherit=true reads.
   * - `{ kind: 'tenant', tenantId }` — visible to every project + org
   *   inside the tenant (top of hierarchy).
   */
  readonly scope: Scope;
  /**
   * REQUIRED. Called inside the binding's write tx after insert,
   * receiving the business `endpointId`. Returns tuples for the tx —
   * `mcp_endpoint#scope@{tenant|org|project}:X` per the model.
   * See `AgentPublishInput.enqueueTuples` for the design rationale.
   */
  readonly enqueueTuples: TupleEnqueueHook;
}

export interface MCPEndpointUnregisterInput {
  readonly tenantId: TenantId;
  readonly endpointId: string;
}

export interface MCPEndpointPage {
  readonly data: readonly MCPEndpoint[];
  readonly nextCursor?: Cursor;
}

export type MCPEndpointRegisterOutcome =
  | { readonly kind: 'ok'; readonly endpointId: string }
  | { readonly kind: 'already-registered'; readonly endpointId: string }
  | {
      readonly kind: 'project-not-found';
      readonly endpointId: string;
      readonly projectId: import('@kindgi/types').ProjectId;
    }
  | {
      readonly kind: 'org-not-found';
      readonly endpointId: string;
      readonly orgId: import('@kindgi/types').OrgId;
    };

export type MCPEndpointUnregisterOutcome = {
  readonly unregistered: boolean;
};

/**
 * Caller-plugged probe for remote MCP endpoints' resources + prompts
 * primitives. The runtime supplies an implementation that opens a live
 * MCP client against the endpoint's declared transport, runs the
 * operation, and closes it — typically a fresh client per call to
 * `listResources` / `readResource` / `listPrompts` / `getPrompt`.
 *
 * Duck-typed at the wire boundary: return shapes mirror the MCP spec so
 * this file doesn't have to depend on an MCP client library. The
 * implementation maps its client's types into these shapes.
 */
export interface MCPClientProbeBinding {
  listResources(input: MCPClientProbeInput): Promise<MCPListResourcesOutcome>;
  readResource(
    input: MCPClientProbeInput & { readonly uri: string },
  ): Promise<MCPReadResourceOutcome>;
  listPrompts(input: MCPClientProbeInput): Promise<MCPListPromptsOutcome>;
  getPrompt(
    input: MCPClientProbeInput & {
      readonly name: string;
      readonly args?: Readonly<Record<string, string>>;
    },
  ): Promise<MCPGetPromptOutcome>;
}

export interface MCPClientProbeInput {
  readonly tenantId: TenantId;
  readonly endpointId: string;
}

/** MCP-spec resource descriptor. */
export interface MCPResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** MCP-spec resource content payload — exactly one of `text` or `blob`. */
export interface MCPResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

/** MCP-spec prompt argument spec. */
export interface MCPPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

/** MCP-spec prompt descriptor. */
export interface MCPPromptDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly MCPPromptArgument[];
}

/** MCP-spec prompt message. */
export interface MCPPromptMessage {
  readonly role: 'user' | 'assistant';
  readonly content:
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly data: string; readonly mimeType: string };
}

export type MCPListResourcesOutcome =
  | { readonly kind: 'ok'; readonly resources: readonly MCPResourceDescriptor[] }
  | { readonly kind: 'endpoint-not-found' }
  | { readonly kind: 'protocol-error'; readonly message: string };

export type MCPReadResourceOutcome =
  | { readonly kind: 'ok'; readonly content: MCPResourceContent }
  | { readonly kind: 'endpoint-not-found' }
  | { readonly kind: 'resource-not-found'; readonly uri: string }
  | { readonly kind: 'read-failed'; readonly message: string };

export type MCPListPromptsOutcome =
  | { readonly kind: 'ok'; readonly prompts: readonly MCPPromptDescriptor[] }
  | { readonly kind: 'endpoint-not-found' }
  | { readonly kind: 'protocol-error'; readonly message: string };

export type MCPGetPromptOutcome =
  | { readonly kind: 'ok'; readonly messages: readonly MCPPromptMessage[] }
  | { readonly kind: 'endpoint-not-found' }
  | { readonly kind: 'prompt-not-found'; readonly name: string }
  | { readonly kind: 'get-failed'; readonly message: string };
