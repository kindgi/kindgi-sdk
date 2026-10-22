// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Connections: accounts at other apps (a member's Google account, the
 * company's GitHub App) that tools act with.
 *
 * @wire /v1/connection-entries, /v1/connection-apps/*, /v1/connections/*  (packages/api/src/routes/connections.ts)
 * @generated Wire shapes imported from `../generated/api.js`.
 *
 * Three clients:
 * - `client.connectionEntries`: the apps this server can connect to.
 * - `client.connectionApps`: the tenant's own registration of its client at
 *   an app (a tenant admin's; secrets are referenced by name, never sent).
 * - `client.connections`: the connected accounts, and the connect that makes one.
 *
 * A connection's token never leaves the server. To connect, `connect()` makes
 * a request; send the person to its `connectUrl`, or call `startRequest()` for
 * the app's consent page. When the app sends them back, pass what it sent to
 * `finish()`.
 *
 * The app's removal notices (`POST /v1/connection-notices/{tenantId}/{appId}`)
 * are sent by the app, not by this client.
 */

import type {
  ConnectFinish as ConnectFinishWire,
  ConnectRequest as ConnectRequestWire,
  ConnectStart,
  ConnectionAppPage as ConnectionAppPageWire,
  ConnectionAppRemoved,
  ConnectionApp as ConnectionAppWire,
  ConnectionEntryList,
  ConnectionEntry as ConnectionEntryWire,
  ConnectionPage as ConnectionPageWire,
  Connection as ConnectionWire,
  CreateConnectRequestBody,
  CreateConnectionAppBody,
  FinishConnectBody,
  StartConnectBody,
  UpdateConnectionAppBody,
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
export type ConnectRequest = ConnectRequestWire;
export type ConnectInput = CreateConnectRequestBody;
export type StartConnectInput = StartConnectBody;
export type FinishConnectInput = FinishConnectBody;
export type ConnectFinish = ConnectFinishWire;
export type ConnectionStartResult = ConnectStart;

export interface ListConnectionAppsFilter {
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
  /** @wire DELETE /v1/connections/:connectionId — withdraws access at the app where it can. */
  disconnect(connectionId: string, options?: MutationOptions): Promise<Connection>;
  /** @wire POST /v1/connections — makes a connect request. */
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
  /** @wire POST /v1/connections/finish — what the app sent back to the callback page. */
  finish(input: FinishConnectInput, options?: MutationOptions): Promise<ConnectFinish>;
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
