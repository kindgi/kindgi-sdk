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
import type { Context, Hono } from 'hono';

import { retryAfterSeconds } from '../errors.js';
import type { TokenResolution, TokenResolver } from '../middleware/auth.js';
import { noStoreMiddleware } from '../middleware/no-store.js';
import {
  type TenantLimiter,
  takeApiRequests,
  tenantLimitReached,
} from '../middleware/tenant-limits.js';
import type { AppEnv } from '../types.js';
import {
  type InProcessCaller,
  type V1Call,
  type V1Route,
  inProcessCover,
  inProcessV1Call,
} from './in-process.js';
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
   * `kindgi:schedule`). The tools call `/v1` as that person, with their
   * key's `tokenRole`, so a resolution that names someone else (a service
   * account, a system principal) or narrows the person further
   * (`tokenProjectId`, `reviewerRole`, `lastActiveAt`) is refused rather
   * than served without it.
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
/** In place of the context: a tool call past the tenant's minute, and what it answers. */
const BUSY_KEY = 'kindgi-busy';

/**
 * The most `/v1` calls one JSON-RPC message's tools make on the count it
 * took at `/mcp`. Past it, each call counts as any `/v1` request does. A
 * test keeps it at or above the tools' most, worked out from their waits
 * and list pages.
 */
export const MCP_CALLS_PER_MESSAGE = 40;

/**
 * `limiter`: the tenant's API requests a minute, when the deployment
 * limits them. Each JSON-RPC message counts once, and its tools' `/v1`
 * calls count on that.
 */
export function mountMcpServer(
  app: Hono<AppEnv>,
  input: McpServerInput,
  toolSets: readonly McpToolSet[],
  limiter?: TenantLimiter,
): void {
  const link = consolePageLinks(input.consoleUrl);
  const handler = createMcpHandler(async ({ authInfo }) => {
    const server = new McpServer(
      { name: 'kindgi', version: input.version },
      { instructions: INSTRUCTIONS },
    );
    const busy = authInfo?.extra?.[BUSY_KEY];
    if (typeof busy === 'string') return busyServer(server, busy);
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
    const person = chatPerson(resolution);
    if ('refusal' in person) {
      return Response.json(
        { error: 'access_denied', error_description: person.refusal },
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
    const body = await jsonBodyOf(c.req.raw);
    const asked = askedOf(body);
    const messages = messagesIn(body);
    const past = await pastTheLimit(c, limiter, resolution.tenantId, messages, asked);
    if (past instanceof Response) return past;
    if (past !== undefined) {
      return handler.fetch(c.req.raw, { authInfo: { ...authInfo, extra: { [BUSY_KEY]: past } } });
    }
    // The person, narrowed to what the chat scopes allow, with none of the
    // capabilities a resolution can carry.
    const caller: InProcessCaller = {
      resolution: {
        tenantId: resolution.tenantId,
        userId: person.userId,
        ...(resolution.tokenId !== undefined && { tokenId: resolution.tokenId }),
        ...(resolution.tokenRole !== undefined && { tokenRole: resolution.tokenRole }),
        ...(resolution.expiresAt !== undefined && { expiresAt: resolution.expiresAt }),
        scopes,
      },
      allowedActions: allowedActionsOf(scopes),
      cover: inProcessCover(MCP_CALLS_PER_MESSAGE * messages),
    };
    const routes = toolSets.filter((set) => served(set, scopes)).flatMap((set) => set.routes);
    const context: McpToolContext = {
      tenantId: resolution.tenantId,
      userId: person.userId,
      scopes,
      call: inProcessV1Call(
        app,
        caller,
        { requestId: c.get('requestId'), traceparent: c.req.header('traceparent') },
        routes,
      ),
      link,
      asked,
    };
    return handler.fetch(c.req.raw, {
      authInfo: { ...authInfo, extra: { [CONTEXT_KEY]: context } },
    });
  });
}

/**
 * The person a chat token acts for, or why it's refused. The tools' `/v1`
 * calls carry only the person, their key's role and the chat scopes, so a
 * resolution for anyone else, or one that limits the person further, is
 * refused: served without its limit, it would reach more than it was given.
 */
function chatPerson(
  resolution: TokenResolution,
): { readonly userId: UserId } | { readonly refusal: string } {
  const { userId } = resolution;
  if (
    userId === undefined ||
    resolution.serviceAccountId !== undefined ||
    resolution.system !== undefined ||
    resolution.systemKeysOperator !== undefined
  ) {
    return { refusal: 'Only a person can use Kindgi from a chat app.' };
  }
  if (
    resolution.tokenProjectId !== undefined ||
    resolution.reviewerRole !== undefined ||
    resolution.lastActiveAt !== undefined
  ) {
    return {
      refusal:
        "A chat app can't keep this token's limits (one project, a reviewer role or an inactivity timeout).",
    };
  }
  return { userId };
}

/**
 * Takes the request's messages from the tenant's API requests a minute.
 * Past it: for a tool call, what its tool answers (`busyServer`), so the
 * chat app's model can say it; for anything else, the API's 429.
 * `undefined`: within it, or no limit.
 */
async function pastTheLimit(
  c: Context<AppEnv>,
  limiter: TenantLimiter | undefined,
  tenantId: TenantId,
  messages: number,
  asked: McpAsked,
): Promise<Response | string | undefined> {
  if (limiter === undefined) return undefined;
  const taken = await takeApiRequests(c, limiter, tenantId, messages);
  if (taken.allowed) return undefined;
  if (asked.method === 'tools/call') return busyText(taken.retryAfterMs);
  return tenantLimitReached(c, 'api-requests', taken.retryAfterMs);
}

/**
 * A tool call past the tenant's minute: every tool answers `text` as its
 * error, and nothing is read or started.
 */
function busyServer(server: McpServer, text: string): McpServer {
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler('tools/call', () => ({
    content: [{ type: 'text', text }],
    isError: true,
  }));
  return server;
}

/** When to try again, from the end of the tenant's minute, in words a person reads. */
function busyText(retryAfterMs: number): string {
  const seconds = retryAfterSeconds(retryAfterMs);
  return `Kindgi is busy: this workspace has reached its limit on requests a minute, so nothing was done. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
}

/** A POST's body, read as JSON; `undefined` for another method or a body that isn't JSON. */
async function jsonBodyOf(request: Request): Promise<{ readonly json: unknown } | undefined> {
  if (request.method !== 'POST') return undefined;
  try {
    return { json: await request.clone().json() };
  } catch {
    // The library answers a body that isn't JSON.
    return undefined;
  }
}

/**
 * The most messages the MCP library serves in one batch: its own
 * `MAX_BATCH_SIZE` (2.4.0), which it doesn't export. It refuses a longer one.
 */
const MAX_BATCH = 100;

/**
 * How many times a request counts toward the tenant's API requests a
 * minute: once for each message in a batch, else once (one message, a
 * `GET` or `DELETE`, or a body the library refuses, such as a batch longer
 * than it serves).
 */
function messagesIn(body: { readonly json: unknown } | undefined): number {
  if (body === undefined || !Array.isArray(body.json)) return 1;
  const { length } = body.json;
  return length > MAX_BATCH ? 1 : Math.max(length, 1);
}

function askedOf(read: { readonly json: unknown } | undefined): McpAsked {
  if (read === undefined) return {};
  const body = read.json;
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
