// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Connections: accounts at other apps (a member's Google account, the
 * company's GitHub App) that tools act with.
 *
 * @wire /v1/connection-entries, /v1/connection-apps/*, /v1/connections/*, /v1/connection-choices/*  (packages/api/src/routes/connections.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * Four clients:
 * - `client.connectionEntries`: the apps this server can connect to.
 * - `client.connectionApps`: the workspace's own registration of its client at
 *   an app (a tenant admin's; secrets are referenced by name, never sent).
 * - `client.connections`: the connected accounts, and the connect that makes one.
 * - `client.connectionChoices`: which connection an agent or a flow, or one
 *   of its tools, uses for an app in a project: the company's (a project
 *   admin's to set), or a person's own, for their runs (theirs alone).
 *
 * A connection's token never leaves the server. To connect, `connect()` makes
 * a request; send the person to its `connectUrl`, or call `startRequest()` for
 * the app's consent page. When the app sends them back, pass what it sent to
 * `finish()`.
 *
 * The app's removal notices (`POST /v1/connection-notices/{tenantId}/{appId}`)
 * are sent by the app, not by this client, and the texts a texting provider
 * delivers (`/v1/texts-inbound/{tenantId}/{appId}`) by the provider.
 */

import type {
  ConnectFinish as ConnectFinishWire,
  ConnectRequest as ConnectRequestWire,
  ConnectStart,
  ConnectionAppPage as ConnectionAppPageWire,
  ConnectionAppRemoved,
  ConnectionApp as ConnectionAppWire,
  ConnectionCandidatePage as ConnectionCandidatePageWire,
  ConnectionCandidate as ConnectionCandidateWire,
  ConnectionChoiceDeleteResult,
  ConnectionChoiceNeeds as ConnectionChoiceNeedsWire,
  ConnectionChoicePage as ConnectionChoicePageWire,
  ConnectionChoice as ConnectionChoiceWire,
  ConnectionEntryList,
  ConnectionEntry as ConnectionEntryWire,
  ConnectionPage as ConnectionPageWire,
  Connection as ConnectionWire,
  CreateConnectRequestBody,
  CreateConnectionAppBody,
  FinishConnectBody,
  SetConnectionChoiceBody,
  StartConnectBody,
  UpdateConnectionAppBody,
  UpdateConnectionBody,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type ConnectionEntry = ConnectionEntryWire;
export type ConnectionApp = ConnectionAppWire;
export type ConnectionAppPage = ConnectionAppPageWire;
export type CreateConnectionAppInput = CreateConnectionAppBody;
export type UpdateConnectionAppInput = UpdateConnectionAppBody;
export type RemoveConnectionAppResult = ConnectionAppRemoved;
export type Connection = ConnectionWire;
export type ConnectionPage = ConnectionPageWire;
export type UpdateConnectionInput = UpdateConnectionBody;
export type ConnectRequest = ConnectRequestWire;
export type ConnectInput = CreateConnectRequestBody;
export type StartConnectInput = StartConnectBody;
export type FinishConnectInput = FinishConnectBody;
export type ConnectFinish = ConnectFinishWire;
export type ConnectionStartResult = ConnectStart;
export type ConnectionChoice = ConnectionChoiceWire;
export type ConnectionChoicePage = ConnectionChoicePageWire;
export type ConnectionChoiceNeeds = ConnectionChoiceNeedsWire;
export type SetConnectionChoiceInput = SetConnectionChoiceBody;
export type RemoveConnectionChoiceResult = ConnectionChoiceDeleteResult;
export type ConnectionCandidate = ConnectionCandidateWire;
export type ConnectionCandidatePage = ConnectionCandidatePageWire;

export interface ListConnectionAppsFilter {
  /** Removed registrations too, with their `removedAt`. */
  readonly includeRemoved?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListConnectionsFilter {
  readonly projectId?: string;
  /** An app's entry id: `'google'`. */
  readonly app?: string;
  /** `'me'`: only the caller's own, even for a tenant admin. */
  readonly owner?: 'me';
  readonly ownerKind?: 'member' | 'company';
  readonly state?: Connection['state'];
  /** Removed connections too, with the others. */
  readonly includeRemoved?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListConnectionChoicesInput {
  readonly projectId: string;
  readonly agentId?: string;
  readonly flowId?: string;
  /** An app's entry id: `'google'`. */
  readonly app?: string;
  /** Only this tool's own choices. */
  readonly toolId?: string;
  /** `'me'`: only the caller's own, even for a tenant admin. */
  readonly owner?: 'me';
  /** Removed choices too, with their `removedAt` and `removedBy`: a choice's history. */
  readonly includeRemoved?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListConnectionCandidatesInput {
  readonly projectId: string;
  /** An app's entry id: `'google'`. */
  readonly app?: string;
  /** `'me'`: the caller's own instead, in full, with `main`. */
  readonly owner?: 'me';
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RemoveConnectionAppOptions extends MutationOptions {
  /** Remove its live connections too; without it, a registration that has any is refused. */
  readonly withConnections?: boolean;
}

export interface ConnectionEntriesClient {
  /** @wire GET /v1/connection-entries */
  list(): Promise<ConnectionEntryList>;
}

export interface ConnectionAppsClient {
  /** @wire GET /v1/connection-apps */
  list(filter?: ListConnectionAppsFilter): Promise<ConnectionAppPage>;
  /** @wire POST /v1/connection-apps — `clientSecret` and the like name secrets you stored first. */
  create(input: CreateConnectionAppInput, options?: MutationOptions): Promise<ConnectionApp>;
  /** @wire GET /v1/connection-apps/:appId */
  get(appId: string): Promise<ConnectionApp>;
  /** @wire PATCH /v1/connection-apps/:appId */
  update(
    appId: string,
    input: UpdateConnectionAppInput,
    options?: MutationOptions,
  ): Promise<ConnectionApp>;
  /** @wire DELETE /v1/connection-apps/:appId */
  remove(appId: string, options?: RemoveConnectionAppOptions): Promise<RemoveConnectionAppResult>;
}

export interface ConnectionsClient {
  /** @wire GET /v1/connections — a member's own; every one for a tenant admin. */
  list(filter?: ListConnectionsFilter): Promise<ConnectionPage>;
  /** @wire GET /v1/connections/:connectionId */
  get(connectionId: string): Promise<Connection>;
  /**
   * @wire PATCH /v1/connections/:connectionId — one change: renames it
   * (`label`), or makes it its owner's main connection of its app (`main: true`).
   */
  update(
    connectionId: string,
    input: UpdateConnectionInput,
    options?: MutationOptions,
  ): Promise<Connection>;
  /**
   * @wire GET /v1/connections/:connectionId/choices — the live choices that
   * name it, as their one or default or in a set; for its owner or a tenant admin.
   */
  choices(
    connectionId: string,
    filter?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<ConnectionChoicePage>;
  /** @wire DELETE /v1/connections/:connectionId — withdraws access at the app where it can. */
  disconnect(connectionId: string, options?: MutationOptions): Promise<Connection>;
  /**
   * @wire POST /v1/connections — makes a connect request. `reconnects` names
   * the connection to connect again, which must be the same account.
   */
  connect(input: ConnectInput, options?: MutationOptions): Promise<ConnectRequest>;
  /** @wire GET /v1/connections/requests/:requestId */
  getRequest(requestId: string): Promise<ConnectRequest>;
  /**
   * @wire POST /v1/connections/requests/:requestId/start — the app's consent page to send the person to.
   * A GitHub App's takes the installation to attach (`installationId`), or a new one (`newInstallation`).
   */
  startRequest(
    requestId: string,
    input?: StartConnectInput,
    options?: MutationOptions,
  ): Promise<ConnectionStartResult>;
  /**
   * @wire POST /v1/connections/finish — what the app sent back to the callback page.
   * The answer says whether it `reconnected` a connection already there, and
   * `labelTaken` when the name it was to get was another's.
   */
  finish(input: FinishConnectInput, options?: MutationOptions): Promise<ConnectFinish>;
}

export interface ConnectionChoicesClient {
  /**
   * @wire GET /v1/connection-choices — the project's live choices, and with
   * `includeRemoved` the removed ones too; its members may read them: the
   * company's and their own, and every person's for a tenant admin. A
   * choice of a connection removed since stays listed until it's set or removed.
   */
  list(input: ListConnectionChoicesInput): Promise<ConnectionChoicePage>;
  /**
   * @wire PUT /v1/connection-choices — chooses a connection for an agent or
   * a flow, or with `toolId` for one of its tools, for the connection's app.
   * A tool's may be a set (`connectionIds`, `connectionId` its default). A
   * company choice is a project admin's; a person's (`person`) is theirs
   * alone. The connection already chosen answers its choice as it is;
   * another one replaces it with the next version.
   */
  set(input: SetConnectionChoiceInput, options?: MutationOptions): Promise<ConnectionChoice>;
  /**
   * @wire DELETE /v1/connection-choices/{choiceId} — a company choice is a
   * project admin's; a person's, theirs alone.
   */
  remove(choiceId: string, options?: MutationOptions): Promise<RemoveConnectionChoiceResult>;
  /**
   * @wire GET /v1/connection-choices/candidates — the company connections a
   * choice in the project may name. A member who isn't an admin gets only
   * `connectionId` and `name`. With `owner: 'me'`, the caller's own instead.
   */
  candidates(input: ListConnectionCandidatesInput): Promise<ConnectionCandidatePage>;
  /**
   * @wire GET /v1/connection-choices/needs — each of an agent's or a flow's
   * tools' connections, and whether a choice for it may be a set; the tools
   * whose version couldn't be read are in `unread`. It reads an agent's or
   * a flow's: one of them.
   */
  needs(
    input: {
      readonly projectId: string;
      /** An app's entry id: `'google'`. */
      readonly app?: string;
    } & (
      | { readonly agentId: string; readonly flowId?: never }
      | { readonly flowId: string; readonly agentId?: never }
    ),
  ): Promise<ConnectionChoiceNeeds>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

function idempotency(options?: MutationOptions): { idempotencyKey?: string } {
  return options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};
}

export function makeConnectionEntriesClient(transport: Transport): ConnectionEntriesClient {
  return {
    async list() {
      return transport.request<ConnectionEntryList>({
        method: 'GET',
        path: '/v1/connection-entries',
      });
    },
  };
}

export function makeConnectionAppsClient(transport: Transport): ConnectionAppsClient {
  return {
    async list(filter) {
      return transport.request<ConnectionAppPage>({
        method: 'GET',
        path: '/v1/connection-apps',
        query: {
          ...(filter?.includeRemoved === true && { includeRemoved: true }),
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async create(input, options) {
      return transport.request<ConnectionApp>({
        method: 'POST',
        path: '/v1/connection-apps',
        body: input,
        ...idempotency(options),
      });
    },
    async get(appId) {
      return transport.request<ConnectionApp>({
        method: 'GET',
        path: `/v1/connection-apps/${encodeURIComponent(appId)}`,
      });
    },
    async update(appId, input, options) {
      return transport.request<ConnectionApp>({
        method: 'PATCH',
        path: `/v1/connection-apps/${encodeURIComponent(appId)}`,
        body: input,
        ...idempotency(options),
      });
    },
    async remove(appId, options) {
      return transport.request<RemoveConnectionAppResult>({
        method: 'DELETE',
        path: `/v1/connection-apps/${encodeURIComponent(appId)}`,
        ...(options?.withConnections !== undefined && {
          query: { withConnections: options.withConnections },
        }),
        ...idempotency(options),
      });
    },
  };
}

export function makeConnectionsClient(transport: Transport): ConnectionsClient {
  return {
    async list(filter) {
      return transport.request<ConnectionPage>({
        method: 'GET',
        path: '/v1/connections',
        query: {
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
          ...(filter?.app !== undefined && { app: filter.app }),
          ...(filter?.owner !== undefined && { owner: filter.owner }),
          ...(filter?.ownerKind !== undefined && { ownerKind: filter.ownerKind }),
          ...(filter?.state !== undefined && { state: filter.state }),
          ...(filter?.includeRemoved === true && { includeRemoved: true }),
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async get(connectionId) {
      return transport.request<Connection>({
        method: 'GET',
        path: `/v1/connections/${encodeURIComponent(connectionId)}`,
      });
    },
    async update(connectionId, input, options) {
      return transport.request<Connection>({
        method: 'PATCH',
        path: `/v1/connections/${encodeURIComponent(connectionId)}`,
        body: input,
        ...idempotency(options),
      });
    },
    async choices(connectionId, filter) {
      return transport.request<ConnectionChoicePage>({
        method: 'GET',
        path: `/v1/connections/${encodeURIComponent(connectionId)}/choices`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async disconnect(connectionId, options) {
      return transport.request<Connection>({
        method: 'DELETE',
        path: `/v1/connections/${encodeURIComponent(connectionId)}`,
        ...idempotency(options),
      });
    },
    async connect(input, options) {
      return transport.request<ConnectRequest>({
        method: 'POST',
        path: '/v1/connections',
        body: input,
        ...idempotency(options),
      });
    },
    async getRequest(requestId) {
      return transport.request<ConnectRequest>({
        method: 'GET',
        path: `/v1/connections/requests/${encodeURIComponent(requestId)}`,
      });
    },
    async startRequest(requestId, input, options) {
      return transport.request<ConnectionStartResult>({
        method: 'POST',
        path: `/v1/connections/requests/${encodeURIComponent(requestId)}/start`,
        body: input ?? {},
        ...idempotency(options),
      });
    },
    async finish(input, options) {
      return transport.request<ConnectFinish>({
        method: 'POST',
        path: '/v1/connections/finish',
        body: input,
        ...idempotency(options),
      });
    },
  };
}

export function makeConnectionChoicesClient(transport: Transport): ConnectionChoicesClient {
  return {
    async list(input) {
      return transport.request<ConnectionChoicePage>({
        method: 'GET',
        path: '/v1/connection-choices',
        query: {
          projectId: input.projectId,
          ...(input.agentId !== undefined && { agentId: input.agentId }),
          ...(input.flowId !== undefined && { flowId: input.flowId }),
          ...(input.app !== undefined && { app: input.app }),
          ...(input.toolId !== undefined && { toolId: input.toolId }),
          ...(input.owner !== undefined && { owner: input.owner }),
          ...(input.includeRemoved === true && { includeRemoved: true }),
          ...(input.limit !== undefined && { limit: input.limit }),
          ...(input.cursor !== undefined && { cursor: input.cursor }),
        },
      });
    },
    async set(input, options) {
      return transport.request<ConnectionChoice>({
        method: 'PUT',
        path: '/v1/connection-choices',
        body: input,
        ...idempotency(options),
      });
    },
    async remove(choiceId, options) {
      return transport.request<RemoveConnectionChoiceResult>({
        method: 'DELETE',
        path: `/v1/connection-choices/${encodeURIComponent(choiceId)}`,
        ...idempotency(options),
      });
    },
    async candidates(input) {
      return transport.request<ConnectionCandidatePage>({
        method: 'GET',
        path: '/v1/connection-choices/candidates',
        query: {
          projectId: input.projectId,
          ...(input.app !== undefined && { app: input.app }),
          ...(input.owner !== undefined && { owner: input.owner }),
          ...(input.limit !== undefined && { limit: input.limit }),
          ...(input.cursor !== undefined && { cursor: input.cursor }),
        },
      });
    },
    async needs(input) {
      return transport.request<ConnectionChoiceNeeds>({
        method: 'GET',
        path: '/v1/connection-choices/needs',
        query: {
          projectId: input.projectId,
          ...(input.agentId !== undefined && { agentId: input.agentId }),
          ...(input.flowId !== undefined && { flowId: input.flowId }),
          ...(input.app !== undefined && { app: input.app }),
        },
      });
    },
  };
}
