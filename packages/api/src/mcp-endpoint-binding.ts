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

/** How an endpoint signs in, beyond the plain bearer `secretRef` sends. */
export const MCP_AUTH_SCHEMES = ['basic', 'oauth2-client-credentials', 'header'] as const;
export type MCPAuthScheme = (typeof MCP_AUTH_SCHEMES)[number];

/** How a client authenticates to an OAuth 2 token endpoint (RFC 6749 §2.3.1). */
export const MCP_OAUTH_CLIENT_AUTH = ['client_secret_basic', 'client_secret_post'] as const;
export type MCPOAuthClientAuth = (typeof MCP_OAUTH_CLIENT_AUTH)[number];

/**
 * HTTP Basic: `Authorization: Basic base64(<username>:<secret>)`, the secret
 * resolved from `secretRef` (a WordPress Application Password, for one).
 */
export interface MCPBasicAuth {
  readonly scheme: 'basic';
  /** The user name. Not a secret; no `:`. */
  readonly username: string;
  /** The password. */
  readonly secretRef: MCPEndpointSecretRef;
}

/**
 * OAuth 2 client credentials: the runtime asks `tokenUrl` for an access
 * token as `clientId` with the secret `secretRef` names, sends it as the
 * endpoint's bearer, and asks again before it expires (Drupal's Simple OAuth,
 * for one).
 */
export interface MCPOAuth2ClientCredentialsAuth {
  readonly scheme: 'oauth2-client-credentials';
  /** The token endpoint: https, or http to a loopback host. */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** The client secret. */
  readonly secretRef: MCPEndpointSecretRef;
  /** The scopes to ask for, space-separated, sent as-is. Absent: none asked. */
  readonly scope?: string;
  /** An `audience` parameter, for identity providers that need one. Absent: none sent. */
  readonly audience?: string;
  /** How the client authenticates to the token endpoint. Default `client_secret_basic`. */
  readonly clientAuth?: MCPOAuthClientAuth;
}

/** The most headers a `header` auth sends. */
export const MCP_AUTH_HEADERS_MAX = 4;

/** One header a `header` auth sends: `<name>: <prefix><secret>`. */
export interface MCPAuthHeader {
  /** An HTTP header name, unique within the auth (case-insensitive). */
  readonly name: string;
  /** The value. */
  readonly secretRef: MCPEndpointSecretRef;
  /** Text before the secret (`Token `, `ApiKey `). Absent: none. Not a secret. */
  readonly prefix?: string;
}

/**
 * Headers of the server's own, each with a secret: an API key in `X-Api-Key`,
 * a key and a secret in two headers, or `Authorization` with a prefix other
 * than `Bearer ` (`Token …`). Each value is resolved from its `secretRef` when
 * the runtime connects, and never stored or shown.
 */
export interface MCPHeaderAuth {
  readonly scheme: 'header';
  /** 1 to `MCP_AUTH_HEADERS_MAX` headers, distinct by name. */
  readonly headers: readonly MCPAuthHeader[];
}

export type MCPEndpointAuth = MCPBasicAuth | MCPOAuth2ClientCredentialsAuth | MCPHeaderAuth;

/** The secrets an endpoint's `auth` names: its password, client secret, or each header's. */
export function mcpAuthSecretRefs(auth: MCPEndpointAuth): readonly MCPEndpointSecretRef[] {
  return auth.scheme === 'header' ? auth.headers.map((h) => h.secretRef) : [auth.secretRef];
}

/**
 * The secrets an endpoint names, by name: its bearer `secretRef`, and its
 * `auth`'s password, client secret or header secrets.
 */
export function mcpEndpointSecretNames(
  endpoint: Pick<MCPEndpoint, 'secretRef' | 'auth'>,
): readonly string[] {
  return [
    ...(endpoint.secretRef !== undefined ? [endpoint.secretRef.name] : []),
    ...(endpoint.auth !== undefined ? mcpAuthSecretRefs(endpoint.auth).map((r) => r.name) : []),
  ];
}

/** Header names that always carry a credential. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);
/** A `-`/`_`-separated part that marks a header name as a credential's. */
const CREDENTIAL_PARTS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'credential',
  'credentials',
  'signature',
  'session',
  'auth',
]);
/** Two adjacent parts that do (`X-Api-Key`, `Ocp-Apim-Subscription-Key`). */
const CREDENTIAL_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['access', 'key'],
  ['private', 'key'],
  ['auth', 'key'],
  ['subscription', 'key'],
];

/**
 * Whether a header's name says it carries a credential: `Authorization`,
 * `Proxy-Authorization`, `Cookie`, or a name with a part such as `token`,
 * `secret`, `password`, `apikey`, `session`, `signature` or `auth`, or the
 * pair `api-key` (`X-Api-Key`, `X-Auth-Token`, `X-Session-Id`). Such a header
 * can't be set in plaintext `config.headers`: it's sent by reference through
 * `auth` (`scheme: 'header'`) or `secretRef`, and a registered one's value is
 * shown as `[redacted]`.
 */
export function isCredentialHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_HEADERS.has(lower)) return true;
  const parts = lower.split(/[-_]/);
  if (parts.some((p) => CREDENTIAL_PARTS.has(p))) return true;
  return parts.some((p, i) => CREDENTIAL_PAIRS.some(([a, b]) => p === a && parts[i + 1] === b));
}

/** What a registered credential header's value reads back as. */
export const REDACTED_HEADER_VALUE = '[redacted]';

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
   * How the endpoint signs in when it isn't a plain bearer: `basic` (a user
   * name and a password secret) or `oauth2-client-credentials` (a token the
   * runtime fetches and refreshes). Each names its secret by reference. Not
   * with `secretRef`, and not on a `stdio` endpoint. Absent: `secretRef`'s
   * bearer, or no credential.
   */
  readonly auth?: MCPEndpointAuth;
  /**
   * Optional pass-through to the MCP client's server-info instructions
   * slot. Purely informational.
   */
  readonly instructions?: string;
  /** Optional caller-defined metadata bag. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Whether the runtime sends the W3C `traceparent` of the run calling a
   * tool to this endpoint (as a request header; ids only, never content),
   * so the server's logs can be matched to the run. Opt-in: absent or
   * `false` sends none. HTTP transports only (`stdio` has no headers).
   */
  readonly sendTraceparent?: boolean;
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
