// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import { scopeToQuery } from '../scope-wire.js';
import type { Transport } from '../transport.js';
import type {
  McpAgentExposure,
  McpEndpoint,
  McpServerInfo,
  McpTransport,
  RegisterMcpEndpointInput,
  ToolInvocationResult,
  ToolManifest,
} from '../types.js';

/**
 * MCP resource — Model Context Protocol interop.
 *
 * The API routes cover **outbound** MCP endpoints: external MCP
 * servers the tenant has registered as reachable (over `stdio`,
 * `http-sse` or `streamable-http`) — `GET/POST /v1/mcp/endpoints`,
 * `GET /v1/mcp/endpoints/{id}`, `POST .../unregister`, plus each
 * endpoint's resources and prompts.
 *
 * Exposing Kindgi itself as an MCP server (`serverInfo`, `tools`,
 * `agents`, `invokeTool`, `invokeAgent`) has no API routes; those
 * methods throw `not-yet-wired`.
 */
export interface McpClient {
  /**
   * Registered outbound MCP endpoints (external MCP servers the tenant
   * has told the OS about).
   */
  readonly endpoints: McpEndpointsClient;

  /**
   * @unwired No `GET /v1/mcp/server-info` route — the API does not
   *   expose Kindgi as an MCP server.
   */
  serverInfo(): Promise<McpServerInfo>;

  /**
   * @unwired No `GET /v1/mcp/tools` route. List tools with
   *   `client.tools.list()` — the wire `Tool` shape is the MCP
   *   manifest.
   */
  tools(): Promise<ListPage<ToolManifest>>;

  /**
   * @unwired No `GET /v1/mcp/agents` route. List agents with
   *   `client.agents.list()`.
   */
  agents(): Promise<ListPage<McpAgentExposure>>;

  /**
   * @unwired No `POST /v1/mcp/invoke-tool` route; tools run inside
   *   agent and flow runs (`client.runs.start`).
   */
  invokeTool(name: string, input: unknown): Promise<ToolInvocationResult>;

  /**
   * @unwired No `POST /v1/mcp/invoke-agent` route. Run an agent with
   *   `client.runs.start({ agent, input })`.
   */
  invokeAgent(agentId: AgentId, input: unknown): Promise<ToolInvocationResult>;
}

/**
 * Outbound MCP endpoint registry — the set of external MCP servers the
 * tenant has told the OS about. Wire shape at
 * `@kindgi/api/openapi.json#/paths/~1v1~1mcp~1endpoints`.
 */
export interface McpEndpointsClient {
  /**
   * Paginated list of registered endpoints.
   *
   * @wire `GET /v1/mcp/endpoints` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1mcp~1endpoints/get`.
   */
  list(filter?: McpEndpointFilter): Promise<ListPage<McpEndpoint>>;

  /**
   * Register an outbound MCP endpoint.
   *
   * @wire `POST /v1/mcp/endpoints` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1mcp~1endpoints/post`.
   */
  register(
    input: RegisterMcpEndpointInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly endpointId: string }>;

  /**
   * @wire `GET /v1/mcp/endpoints/{endpointId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1mcp~1endpoints~1{endpointId}/get`.
   */
  get(endpointId: string): Promise<McpEndpoint>;

  /**
   * Unregister an endpoint. Unknown ids fail with
   * `404 mcp-endpoint-not-found`; the SDK discards the
   * `{ endpointId, unregistered: true }` body.
   *
   * @wire `POST /v1/mcp/endpoints/{endpointId}/unregister` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1mcp~1endpoints~1{endpointId}~1unregister/post`.
   */
  unregister(endpointId: string, options?: { readonly idempotencyKey?: string }): Promise<void>;

  readonly resources: McpResourcesClient;
  readonly prompts: McpPromptsClient;
}

export interface McpResourcesClient {
  /** @wire GET /v1/mcp/endpoints/:endpointId/resources */
  list(endpointId: string): Promise<{ readonly data: readonly unknown[] }>;
  /** @wire GET /v1/mcp/endpoints/:endpointId/resources/:uri */
  read(endpointId: string, uri: string): Promise<unknown>;
}

export interface McpPromptsClient {
  /** @wire GET /v1/mcp/endpoints/:endpointId/prompts */
  list(endpointId: string): Promise<{ readonly data: readonly unknown[] }>;
  /**
   * Fetch a prompt with arguments filled in. Note: this is a POST
   * on the wire (MCP `getPrompt` is a call, not a static read) —
   * body carries the prompt arguments.
   *
   * @wire POST /v1/mcp/endpoints/:endpointId/prompts/:name
   */
  get(
    endpointId: string,
    name: string,
    args?: Readonly<Record<string, unknown>>,
    options?: { readonly idempotencyKey?: string },
  ): Promise<unknown>;
}

export interface McpEndpointFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly transport?: McpTransport;
}

export function makeMcpClient(transport: Transport): McpClient {
  return {
    endpoints: {
      async list(filter) {
        const page = await transport.request<WirePage<McpEndpoint>>({
          method: 'GET',
          path: '/v1/mcp/endpoints',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
            ...(filter?.transport !== undefined && { transport: filter.transport }),
          },
        });
        return listPage(page);
      },

      async register(input, options) {
        const { scope, ...endpoint } = input;
        return transport.request<{ readonly endpointId: string }>({
          method: 'POST',
          path: '/v1/mcp/endpoints',
          // The scope travels as the `scopeKind` + `scopeId` pair.
          body: { ...endpoint, ...scopeToQuery(scope) },
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },

      async get(endpointId) {
        return transport.request<McpEndpoint>({
          method: 'GET',
          path: `/v1/mcp/endpoints/${encodeURIComponent(endpointId)}`,
        });
      },

      async unregister(endpointId, options) {
        await transport.request<{
          readonly endpointId: string;
          readonly unregistered: true;
        }>({
          method: 'POST',
          path: `/v1/mcp/endpoints/${encodeURIComponent(endpointId)}/unregister`,
          body: {},
          discardResponse: true,
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },

      resources: {
        async list(endpointId) {
          return transport.request<{ readonly data: readonly unknown[] }>({
            method: 'GET',
            path: `/v1/mcp/endpoints/${encodeURIComponent(endpointId)}/resources`,
          });
        },
        async read(endpointId, uri) {
          return transport.request<unknown>({
            method: 'GET',
            path: `/v1/mcp/endpoints/${encodeURIComponent(endpointId)}/resources/${encodeURIComponent(uri)}`,
          });
        },
      },

      prompts: {
        async list(endpointId) {
          return transport.request<{ readonly data: readonly unknown[] }>({
            method: 'GET',
            path: `/v1/mcp/endpoints/${encodeURIComponent(endpointId)}/prompts`,
          });
        },
        async get(endpointId, name, args, options) {
          return transport.request<unknown>({
            method: 'POST',
            path: `/v1/mcp/endpoints/${encodeURIComponent(endpointId)}/prompts/${encodeURIComponent(name)}`,
            body: args ?? {},
            ...(options?.idempotencyKey !== undefined && {
              idempotencyKey: options.idempotencyKey,
            }),
          });
        },
      },
    },

    async serverInfo() {
      throw new KindgiApiError(
        notYetWired(
          'mcp.serverInfo',
          'no GET /v1/mcp/server-info route on the API — inbound MCP-server surface (exposing the OS via MCP) not routed yet',
        ),
      );
    },

    async tools() {
      throw new KindgiApiError(
        notYetWired(
          'mcp.tools',
          'no GET /v1/mcp/tools route on the API — use client.tools.list() (wire Tool IS the MCP manifest)',
        ),
      );
    },

    async agents() {
      throw new KindgiApiError(
        notYetWired(
          'mcp.agents',
          'no GET /v1/mcp/agents route on the API — inbound-server exposure of agents not routed yet',
        ),
      );
    },

    async invokeTool(_name, _input) {
      throw new KindgiApiError(
        notYetWired(
          'mcp.invokeTool',
          'no POST /v1/mcp/invoke-tool route on the API — MCP-transport tool invocation not surfaced yet',
        ),
      );
    },

    async invokeAgent(_agentId, _input) {
      throw new KindgiApiError(
        notYetWired(
          'mcp.invokeAgent',
          'no POST /v1/mcp/invoke-agent route on the API — use client.runs.start({ agent }) for agent invocation',
        ),
      );
    },
  };
}
