// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId, UserId } from '@kindgi/types';
import {
  type AuthInfo,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  bearerAuthChallengeResponse,
  createMcpHandler,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import type { Hono } from 'hono';

import type { TokenResolution, TokenResolver } from '../middleware/auth.js';
import { noStoreMiddleware } from '../middleware/no-store.js';
import type { AppEnv } from '../types.js';
import { type InProcessCaller, type V1Call, type V1Route, inProcessV1Call } from './in-process.js';
import { type ConsolePageLink, consolePageLinks } from './links.js';
import { type McpScope, allowedActionsOf, mcpScopesOf } from './scopes.js';

/**
 * `/mcp`: Kindgi as an MCP server, for chat apps (claude.ai's custom
 * connectors) and other MCP clients, signed in as a person with OAuth.
 */
export interface McpServerInput {
  /**
   * Checks a token issued for this endpoint: the deployment's chat
   * sign-in. Return `null` for one it didn't issue, or issued for another
   * audience. It's separate from the API's own `resolveToken`, so a chat
   * token never opens `/v1`, where routes answer more than the tools do.
   *
   * The resolution must name a person (`userId`) and carry `expiresAt` and
   * the token's granted `scopes` (`kindgi:read`, `kindgi:run`,
   * `kindgi:schedule`). Anything else is refused.
   */
  readonly resolveToken: TokenResolver;
  /**
   * Where the deployment serves this endpoint's OAuth protected-resource
   * metadata (RFC 9728), which names its authorization server. Every 401
   * points to it, so a client finds where to sign in.
   */
  readonly resourceMetadataUrl: string;
  /**
   * The console's base URL (`https://kindgi.acme.example/console`). The
   * tools link each thing they answer about to its page there. Absent: no
   * links.
   */
  readonly consoleUrl?: string;
  /** The deployment's version, as this MCP server's. */
  readonly version: string;
}

/** What a tool set's tools work with, per request. */
export interface McpToolContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  /** The chat scopes the token holds. */
  readonly scopes: readonly McpScope[];
  /** A `/v1` request as the person, to the routes the allowed tool sets declared. */
  readonly call: V1Call;
  readonly link: ConsolePageLink;
  /** What the request asks for, so a tool set loads only what it needs. */
  readonly asked: McpAsked;
}

/** What a request asks for, read from its JSON-RPC body before it's served. */
export interface McpAsked {
  /** The method, when the body is one request. */
  readonly method?: string;
  /** The tool a `tools/call` names. */
  readonly tool?: string;
  /** The body is a batch (2025-03-26), which may ask for anything. */
  readonly batch?: true;
}

/** A group of tools served to a token holding any of its scopes. */
export interface McpToolSet {
  /** A caller whose token holds none of them gets none of these tools. */
  readonly scopes: readonly McpScope[];
  /** Every `/v1` route these tools call. */
  readonly routes: readonly V1Route[];
  readonly register: (server: McpServer, context: McpToolContext) => void | Promise<void>;
}

const INSTRUCTIONS =
  "Kindgi runs a workspace's agents. Use these tools to look at agents, runs and their results, and to start runs as the signed-in person. Each answer links to the same thing in the Kindgi console.";

/** The context a request's tools get, in `AuthInfo.extra`; never sent anywhere. */
const CONTEXT_KEY = 'kindgi';

export function mountMcpServer(
  app: Hono<AppEnv>,
  input: McpServerInput,
  toolSets: readonly McpToolSet[],
): void {
  const link = consolePageLinks(input.consoleUrl);
  const handler = createMcpHandler(async ({ authInfo }) => {
    const server = new McpServer(
      { name: 'kindgi', version: input.version },
      { instructions: INSTRUCTIONS },
    );
    const context = authInfo?.extra?.[CONTEXT_KEY] as McpToolContext | undefined;
    // Every request is admitted below before it gets here; one without a
    // context (a library-internal probe) gets no tools.
    if (context === undefined) return server;
    for (const set of toolSets) {
      if (served(set, context.scopes)) await set.register(server, context);
    }
    return server;
  });

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
      const resolution = await input.resolveToken(token);
      if (resolution === null || resolution.revoked === true) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'The token is not recognized');
      }
      return {
        // Not kept past this check.
        token: '',
        clientId: '',
        scopes: [...(resolution.scopes ?? [])],
        ...(resolution.expiresAt !== undefined && {
          expiresAt: Math.floor(resolution.expiresAt.getTime() / 1000),
        }),
        extra: { resolution },
      };
    },
  };
  const challenge = { resourceMetadataUrl: input.resourceMetadataUrl };

  app.use('/mcp', noStoreMiddleware());
  // Every method: the library answers what MCP's HTTP transport doesn't
  // serve. `/mcp` speaks JSON-RPC, so it isn't an OpenAPI operation.
  app.all('/mcp', async (c) => {
    let authInfo: AuthInfo;
    try {
      authInfo = await verifyBearerToken(c.req.header('authorization'), {
        verifier,
        ...challenge,
      });
    } catch (error) {
      return bearerAuthChallengeResponse(error, challenge);
    }
    const resolution = authInfo.extra?.resolution as TokenResolution;
    if (resolution.userId === undefined || resolution.system !== undefined) {
      return Response.json(
        {
          error: 'access_denied',
          error_description: 'Only a person can use Kindgi from a chat app.',
        },
        { status: 403 },
      );
    }
    const scopes = mcpScopesOf(resolution.scopes);
    if (scopes.length === 0) {
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InsufficientScope, 'The token holds no Kindgi scope'),
        { ...challenge, requiredScopes: ['kindgi:read'] },
      );
    }
    // The person, narrowed to what the chat scopes allow, and nothing
    // else a resolution can carry (capabilities, a system principal).
    const caller: InProcessCaller = {
      resolution: {
        tenantId: resolution.tenantId,
        userId: resolution.userId,
        ...(resolution.tokenId !== undefined && { tokenId: resolution.tokenId }),
        ...(resolution.tokenRole !== undefined && { tokenRole: resolution.tokenRole }),
        ...(resolution.expiresAt !== undefined && { expiresAt: resolution.expiresAt }),
        scopes,
      },
      allowedActions: allowedActionsOf(scopes),
    };
    const routes = toolSets.filter((set) => served(set, scopes)).flatMap((set) => set.routes);
    const context: McpToolContext = {
      tenantId: resolution.tenantId,
      userId: resolution.userId,
      scopes,
      call: inProcessV1Call(
        app,
        caller,
        { requestId: c.get('requestId'), traceparent: c.req.header('traceparent') },
        routes,
      ),
      link,
      asked: await askedOf(c.req.raw),
    };
    return handler.fetch(c.req.raw, {
      authInfo: { ...authInfo, extra: { [CONTEXT_KEY]: context } },
    });
  });
}

async function askedOf(request: Request): Promise<McpAsked> {
  if (request.method !== 'POST') return {};
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    // The library answers a body that isn't JSON.
    return {};
  }
  if (Array.isArray(body)) return { batch: true };
  if (typeof body !== 'object' || body === null) return {};
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } };
  if (typeof method !== 'string') return {};
  const tool = method === 'tools/call' ? params?.name : undefined;
  return { method, ...(typeof tool === 'string' && { tool }) };
}

function served(set: McpToolSet, scopes: readonly McpScope[]): boolean {
  return set.scopes.some((scope) => scopes.includes(scope));
}
