// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { PrincipalRef } from '@kindgi/authz';
import type { AppEntry } from '@kindgi/connections';
import type { ConnectionAccount } from '@kindgi/tools';
import type { Cursor, EnvName, ProjectId, Result, TenantId } from '@kindgi/types';

/**
 * Connections: accounts at other apps (a member's Google account, the
 * company's GitHub App) that tools act with.
 *
 * - **An app registration** is the tenant's own registration at the app
 *   (its OAuth client, its GitHub App), which a tenant admin adds once.
 * - **A connection** is one owner's account, connected through a
 *   registration in one env: a member's own, or the company's.
 * - **A connect request** sends a person to the app's consent page and
 *   finishes when they come back. A run that needs a connection it lacks
 *   can wait for one.
 *
 * Caller-plugged: the runtime owns storage, the token store, the sign-in
 * flows and the app's notices. This package defines the contract and the
 * wire shapes. Nothing here carries a token, an OAuth state or a PKCE
 * verifier.
 */

/** A secret, by reference: its env and name in the tenant's secrets. */
export interface SecretRefInput {
  readonly envName: EnvName;
  readonly name: string;
}

/** Who owns a connection: one member, or the company (the tenant). */
export type ConnectionOwner =
  | { readonly kind: 'member'; readonly userId: string }
  | { readonly kind: 'company' };

export type ConnectionState = 'working' | 'needs-reconnecting' | 'removing' | 'removed';

export type ConnectionRemovedReason =
  | 'disconnected'
  | 'revoked-at-app'
  | 'uninstalled'
  | 'registration-removed'
  | 'replaced';

/**
 * What a removal did at the app:
 * - `at-app`: access was withdrawn there (by Kindgi, or the app already had);
 * - `app-failed`: the app's revoke failed; the token is gone here all the same;
 * - `kept-for-other-connection`: the app's revoke is grant-wide and another
 *   live connection uses the grant, so it wasn't called;
 * - `not-supported`: the app has no revoke, or what it has would undo more
 *   than this connection (a GitHub App's installation stays installed).
 */
export type ConnectionWithdrawn =
  | 'at-app'
  | 'app-failed'
  | 'kept-for-other-connection'
  | 'not-supported';

/** A tenant's registration of an app. */
export interface ConnectionAppRecord {
  readonly appId: string;
  readonly tenantId: TenantId;
  /** The app's entry id: `'google'`. */
  readonly app: string;
  readonly label?: string;
  readonly oauth2?: {
    readonly clientId: string;
    readonly clientSecret: SecretRefInput;
    /**
     * The directory the app signs people in at, for an entry whose sign-in
     * names one (`signIn.tenant`): Microsoft's tenant id or domain,
     * `organizations`, `common` or `consumers`. Required when the entry has
     * no default, refused for an entry without one (`connection-app-invalid`).
     */
    readonly tenant?: string;
  };
  readonly githubApp?: {
    readonly appNumber: number;
    readonly slug: string;
    readonly clientId: string;
    readonly clientSecret: SecretRefInput;
    readonly privateKey: SecretRefInput;
    readonly webhookSecret: SecretRefInput;
  };
  /** The projects whose runs may use its connections. Absent: every project. */
  readonly projects?: readonly ProjectId[];
  /** `<publicUrl>/console/connect/callback`: the admin gives it to the app (a GitHub App's Callback URL, with user authorization during installation). */
  readonly redirectUrl: string;
  /** `<publicUrl>/v1/connection-notices/<tenantId>/<appId>`: where the app reports removals. */
  readonly noticesUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removedAt?: string;
}

/** One owner's account at an app, through a registration, in one env. */
export interface ConnectionRecord {
  readonly connectionId: string;
  readonly tenantId: TenantId;
  readonly envName: EnvName;
  readonly appId: string;
  readonly app: string;
  readonly owner: ConnectionOwner;
  readonly account: ConnectionAccount;
  /** The entry's permission keys the app granted. */
  readonly permissions: readonly string[];
  readonly state: ConnectionState;
  /**
   * Why it's in its state: `'invalid-grant'` (the app withdrew the grant),
   * `'no-refresh-token'` (the app gave no way to renew it), `'token-missing'`
   * (its stored token is gone), `'store-write-failed'` (its token couldn't be
   * stored at the connect), `'installation-missing'` (the GitHub App was
   * uninstalled from the account), `'installation-permissions'` (an owner took
   * permissions from the installation), `'suspended'` (the installation was
   * suspended), `'sessions-revoked'` (Google revoked the person's sessions),
   * `'access-expired'` (the app gave no refresh token, and its access token
   * ends within a minute, or has ended). Other values may be added; `state`
   * says what to do.
   */
  readonly stateReason?: string;
  readonly installationId?: string;
  /**
   * When its access token ends, for a connection the app gave no refresh
   * token (an entry whose `signIn.refreshToken` is `'optional'`). From one
   * minute before then, it needs reconnecting (`access-expired`), and reads
   * say so too. Absent for one that renews.
   */
  readonly accessEndsAt?: string;
  /** When its current grant was stored: the connect, or the last reconnect. */
  readonly connectedAt: string;
  /** When a run last used it, to the hour. */
  readonly lastUsedAt?: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly removedAt?: string;
  readonly removedBy?: string;
  readonly removedReason?: ConnectionRemovedReason;
  readonly withdrawn?: ConnectionWithdrawn;
}

export type ConnectRequestState = 'pending' | 'connected' | 'declined' | 'expired' | 'failed';

/** A GitHub App installation a person can reach, offered to pick from. */
export interface ConnectRequestInstallation {
  readonly installationId: string;
  /** The account it's on: its login, or the enterprise's slug. */
  readonly account: ConnectionAccount;
}

/** A connect: the owner goes to `connectUrl`, consents at the app, and comes back. */
export interface ConnectRequestRecord {
  readonly requestId: string;
  readonly tenantId: TenantId;
  readonly envName: EnvName;
  readonly appId: string;
  readonly app: string;
  readonly owner: ConnectionOwner;
  /** The permissions asked for: the ones needed, and the ones already granted. */
  readonly permissions: readonly string[];
  /** What each asks for, in plain words. */
  readonly says: readonly string[];
  /** The connection it connects again; the same account is required. */
  readonly reconnects?: string;
  readonly runId?: string;
  /** The run's waitpoint token, when a run waits for it. */
  readonly waitToken?: string;
  /**
   * The tool's name for the connection (its `needsSpec.connections` key),
   * when a run waits for it. Needs that share the request: the first of
   * their names in sorted order, the one its `waitToken` is made from.
   */
  readonly name?: string;
  /** Who started it last: `<kind>:<id>`. Only they may finish it. */
  readonly startedBy?: string;
  readonly state: ConnectRequestState;
  /** Why it failed: `'account-mismatch'`, `'app-refused'`, `'store-write-failed'`. */
  readonly failure?: string;
  /** The permissions the app granted less than asked. */
  readonly missing?: readonly string[];
  /**
   * A GitHub App's, while it's `pending`: the app's installations the
   * person's GitHub account reaches, when the finish found several and
   * none was picked. They pick one and start again (`startRequest`'s
   * `installationId`), or install the app on another account
   * (`newInstallation`).
   */
  readonly installations?: readonly ConnectRequestInstallation[];
  readonly connectionId?: string;
  /** Absolute: the server's public URL. */
  readonly connectUrl: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** The codes a `ConnectionBinding` refuses with. The routes answer them in the error body's `code`. */
export type ConnectionErrorCode =
  | 'connection-app-not-found'
  | 'connection-not-found'
  | 'connection-request-not-found'
  | 'connection-app-invalid'
  | 'connection-app-unknown-entry'
  | 'connection-app-in-use'
  | 'connection-not-yours'
  | 'connection-installation-unreachable'
  | 'connection-request-expired'
  | 'connection-request-used'
  | 'connection-state-expired'
  | 'connection-account-mismatch'
  | 'connection-removing'
  | 'connection-app-refused'
  | 'connection-notice-invalid'
  | 'connection-notice-unavailable'
  | 'connection-store-failed'
  | 'bad-input';

export interface ConnectionError {
  readonly code: ConnectionErrorCode;
  readonly message: string;
  /** The input field at fault (`connection-app-invalid`, `bad-input`). */
  readonly field?: string;
  /**
   * The connect request it's about, for its starter to go on with
   * (`connection-installation-unreachable`: start it again with
   * `newInstallation`).
   */
  readonly connectRequestId?: string;
}

export interface ConnectionPage<T> {
  readonly data: readonly T[];
  readonly nextCursor?: Cursor;
}

export interface ConnectionAppCreateInput {
  readonly tenantId: TenantId;
  readonly app: string;
  readonly label?: string;
  readonly oauth2?: ConnectionAppRecord['oauth2'];
  readonly githubApp?: ConnectionAppRecord['githubApp'];
  readonly projects?: readonly ProjectId[];
  readonly by: PrincipalRef;
}

export interface ConnectionAppUpdateInput
  extends Partial<Omit<ConnectionAppCreateInput, 'tenantId' | 'app' | 'projects' | 'by'>> {
  readonly tenantId: TenantId;
  readonly appId: string;
  /** `null`: every project. */
  readonly projects?: readonly ProjectId[] | null;
  readonly by: PrincipalRef;
}

export interface ConnectionListInput {
  readonly tenantId: TenantId;
  /** Those whose registration allows this project. */
  readonly projectId?: ProjectId;
  readonly app?: string;
  readonly ownerUserId?: string;
  readonly ownerKind?: 'member' | 'company';
  readonly state?: ConnectionState;
  readonly includeRemoved?: boolean;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface ConnectRequestCreateInput {
  readonly tenantId: TenantId;
  readonly envName: EnvName;
  readonly app: string;
  /** Which registration, when the tenant has more than one for the app. */
  readonly appId?: string;
  /** When given, the registration must allow it. */
  readonly projectId?: ProjectId;
  readonly owner: ConnectionOwner;
  readonly permissions: readonly string[];
  readonly by: PrincipalRef;
}

/** What the app sent back to the callback page, with the caller's session. */
export interface ConnectFinishInput {
  readonly tenantId: TenantId;
  readonly caller: PrincipalRef;
  readonly state: string;
  readonly code?: string;
  /** A GitHub App's. */
  readonly installationId?: string;
  readonly setupAction?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

export type ConnectFinishOutcome =
  | {
      readonly kind: 'connected';
      readonly request: ConnectRequestRecord;
      readonly connection: ConnectionRecord;
    }
  /** The person declined, or granted less than asked (`request.missing`). */
  | { readonly kind: 'declined'; readonly request: ConnectRequestRecord }
  /**
   * A GitHub App's: the person's GitHub account reaches several
   * installations and none was picked. The request stays `pending`, with
   * its `installations` to pick from.
   */
  | { readonly kind: 'pick-installation'; readonly request: ConnectRequestRecord };

/**
 * The store behind the connections routes. A runtime implements it; an
 * in-memory one is for development and tests. The routes mount only when
 * one is given.
 */
export interface ConnectionBinding {
  /** The app entries this server knows. */
  entries(): readonly AppEntry[];

  listApps(input: {
    readonly tenantId: TenantId;
    readonly limit: number;
    readonly cursor?: Cursor;
    readonly includeRemoved?: boolean;
  }): Promise<ConnectionPage<ConnectionAppRecord>>;
  getApp(input: {
    readonly tenantId: TenantId;
    readonly appId: string;
  }): Promise<ConnectionAppRecord | null>;
  /**
   * A project uses one registration of an app: one that would serve a
   * project another live registration of the app serves is refused
   * (`connection-app-invalid`, `projects`).
   */
  createApp(input: ConnectionAppCreateInput): Promise<Result<ConnectionAppRecord, ConnectionError>>;
  /**
   * As `createApp` for `projects`. A change of the client its connections
   * were granted to (`oauth2.clientId`, `oauth2.tenant` as the sign-in uses
   * it, `githubApp.appNumber` or `githubApp.clientId`) while it has live
   * connections is refused (`connection-app-invalid`, that field): disconnect
   * them first, then change it and connect again.
   */
  updateApp(input: ConnectionAppUpdateInput): Promise<Result<ConnectionAppRecord, ConnectionError>>;
  /** With `withConnections: false`, a registration that still has live connections is refused (`connection-app-in-use`). */
  removeApp(input: {
    readonly tenantId: TenantId;
    readonly appId: string;
    readonly withConnections: boolean;
    readonly by: PrincipalRef;
  }): Promise<Result<{ readonly connectionsRemoved: number }, ConnectionError>>;

  list(input: ConnectionListInput): Promise<ConnectionPage<ConnectionRecord>>;
  get(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
  }): Promise<ConnectionRecord | null>;
  /**
   * Withdraws access at the app where it can, destroys the token, and
   * removes the connection. Idempotent: on a connection still `removing`,
   * it carries on from the withdrawal.
   */
  disconnect(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
    readonly by: PrincipalRef;
  }): Promise<Result<ConnectionRecord, ConnectionError>>;

  /** A connect from outside a run (a Connect button, the CLI). A run's connects are the resolver's. */
  createRequest(
    input: ConnectRequestCreateInput,
  ): Promise<Result<ConnectRequestRecord, ConnectionError>>;
  getRequest(input: {
    readonly tenantId: TenantId;
    readonly requestId: string;
  }): Promise<ConnectRequestRecord | null>;
  /**
   * Every request a run made, in any state. A run's `waitingFor` keeps
   * the pending ones whose `waitToken` is one of its open waits.
   */
  requestsForRun(input: {
    readonly tenantId: TenantId;
    readonly runId: string;
  }): Promise<readonly ConnectRequestRecord[]>;
  /**
   * The owner (a member's), or a tenant admin (the company's), starts it:
   * a fresh state and PKCE verifier, good for 10 minutes, and the app's
   * consent page to send them to. Records who started it.
   *
   * A GitHub App's goes to the app's install page while the app has no
   * installation, or with `newInstallation`; otherwise to GitHub's user
   * authorization. Either field on another app's request is `bad-input`.
   */
  startRequest(input: {
    readonly tenantId: TenantId;
    readonly requestId: string;
    readonly caller: PrincipalRef;
    /** A GitHub App's: the installation to attach, one of the request's `installations`. */
    readonly installationId?: string;
    /** A GitHub App's: install the app on another account, even when it has installations. */
    readonly newInstallation?: true;
  }): Promise<Result<{ readonly authorizeUrl: string }, ConnectionError>>;
  /**
   * Only whoever started it may finish it (`connection-not-yours`). Checks
   * the request's life, then the state's; exchanges the code, learns the
   * account, compares what was granted with what was asked, stores the
   * connection, then completes and resumes a run that waits.
   *
   * A request that isn't a reconnect, whose key gained a live connection
   * after it was made, finishes as a reconnect of that connection: the
   * same account is required (`connection-account-mismatch`), and the
   * permissions are both sets.
   *
   * A GitHub App's attaches an installation only if the person's GitHub
   * account reaches it: the one GitHub sent back, the one they picked, or
   * the only one they reach. None they reach is
   * `connection-installation-unreachable`, with the request's id: the way
   * on is installing the app on their account (`newInstallation`). Several
   * and none picked is `pick-installation`: the request stays `pending`
   * with its `installations`, and no `failure`.
   */
  finishRequest(input: ConnectFinishInput): Promise<Result<ConnectFinishOutcome, ConnectionError>>;

  /**
   * A removal the app reports (an uninstall, a revoke at the app). Checked
   * by the app's own signature; anything not accepted is
   * `connection-notice-invalid`. `connection-notice-unavailable` (the
   * app's keys or the store couldn't be read) and a failed change are the
   * server's, and the app may send it again.
   */
  receiveNotice(input: {
    readonly tenantId: TenantId;
    readonly appId: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly rawBody: Uint8Array;
  }): Promise<Result<{ readonly handled: string; readonly connections: number }, ConnectionError>>;
}
