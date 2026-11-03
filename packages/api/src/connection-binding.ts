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
  /**
   * The name people know it by: the one asked for at the connect, else the
   * account's label. Absent on a connection made before connections had
   * names; show `account.label` then.
   */
  readonly label?: string;
  /**
   * A person's connection that is their main one through its registration
   * in its env: their agents use it when nothing chooses another. Only ever
   * `true`; absent on every other connection, the company's too. A person's
   * first connection gets no main; their second connection makes the first
   * one main.
   */
  readonly main?: boolean;
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
  /** The name asked for the connection it makes. A reconnect keeps the connection's. */
  readonly label?: string;
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

/** What a choice is for: an agent, or a flow. */
export type ConnectionChoiceTarget =
  | { readonly agentId: string; readonly flowId?: never }
  | { readonly flowId: string; readonly agentId?: never };

/**
 * Which connection an agent (or a flow) uses for an app in a project, in
 * one env: the company's choice, or a person's own (`person`) for the runs
 * that act for them. With `toolId`, it's for that tool's need alone and
 * comes before the agent's own choice. Never changed: a change removes it
 * and makes a new one at the next version.
 */
export type ConnectionChoiceRecord = ConnectionChoiceTarget & {
  readonly choiceId: string;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly envName: EnvName;
  /** The app's entry id (`google`): the connection's. */
  readonly app: string;
  /** The tool it's for, with `need`; absent: every tool of the agent or flow that uses the app. */
  readonly toolId?: string;
  /** The tool's name for the connection (a key of its `needs.connections`), with `toolId`. */
  readonly need?: string;
  /** The chosen connection; with `connectionIds`, the set's default. */
  readonly connectionId: string;
  /**
   * A set (2 to 10, `connectionId` among them) for a read tool: each call
   * names the one it reads (the model's `accounts` input), and one that
   * names none reads `connectionId`.
   */
  readonly connectionIds?: readonly string[];
  /** A person's own choice: it names their connections, and only their runs read it. Absent: the company's. */
  readonly person?: { readonly userId: string };
  /** From 1, per project, env, agent or flow, app, tool and need, and person. */
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly removedAt?: string;
  readonly removedBy?: string;
};

/** A connection a choice in a project may name: a company one, or a person's own for their choices. */
export interface ConnectionCandidateRecord {
  readonly connectionId: string;
  /** Its label, else its account's label. */
  readonly name: string;
  readonly app: string;
  readonly accountLabel: string;
  readonly state: ConnectionState;
  /** A person's main one (`ConnectionRecord.main`). */
  readonly main?: boolean;
}

/** Why a tool's need can't take a set of connections. */
export type ConnectionSetRefusal = 'changes' | 'sensitive-data-egress' | 'accounts-input';

/**
 * A need of one of an agent's or flow's tools, at the version it resolves
 * to now: what a choice for the tool names, and whether it may be a set.
 */
export interface ConnectionChoiceNeedRecord {
  readonly toolId: string;
  /** The tool's name for the connection. */
  readonly need: string;
  readonly app: string;
  /** Whose account the need uses: a person's own, or the company's. */
  readonly as: 'company' | 'person';
  /**
   * Whether a choice for it may hold several connections: only a read
   * tool's (`mutating: false` and no changing effect), that doesn't
   * declare `sensitive-data-egress` and has no `accounts` input of its own.
   */
  readonly set:
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: ConnectionSetRefusal };
}

/** An agent's or flow's needs; `unread` names its tools whose version couldn't be read. */
export interface ConnectionChoiceNeeds {
  readonly data: readonly ConnectionChoiceNeedRecord[];
  readonly unread?: readonly string[];
}

/** The codes a `ConnectionBinding` refuses with. The routes answer them in the error body's `code`. */
export type ConnectionErrorCode =
  | 'connection-app-not-found'
  | 'connection-not-found'
  | 'connection-request-not-found'
  | 'connection-choice-not-found'
  | 'agent-not-found'
  | 'flow-not-found'
  | 'connection-app-invalid'
  | 'connection-app-unknown-entry'
  | 'connection-app-in-use'
  | 'connection-not-yours'
  | 'connection-installation-unreachable'
  | 'connection-request-expired'
  | 'connection-request-used'
  | 'connection-state-expired'
  | 'connection-account-mismatch'
  | 'connection-label-taken'
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

export interface ConnectionChoiceListInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly envName: EnvName;
  readonly agentId?: string;
  readonly flowId?: string;
  readonly app?: string;
  /** Only the choices for this tool. */
  readonly toolId?: string;
  /**
   * Whose choices: the company's (`company`), and a person's own
   * (`person: {userId}`) or every person's (`person: 'every'`). Absent:
   * the company's only.
   */
  readonly owners?: {
    readonly company: boolean;
    readonly person?: { readonly userId: string } | 'every';
  };
  /** Removed choices too: a choice's history. */
  readonly includeRemoved?: boolean;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export type ConnectionChoiceSetInput = ConnectionChoiceTarget & {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly envName: EnvName;
  /** The choice's connection; with `connectionIds`, the set's default, one of them. */
  readonly connectionId: string;
  /** For this tool's need alone. */
  readonly toolId?: string;
  /** The tool's name for the connection; may be left out when the tool has one need of the app. */
  readonly need?: string;
  /** A set, 2 to 10, for a read tool's need (`toolId`). */
  readonly connectionIds?: readonly string[];
  /** A person's own choice, made by that person: their connections only. */
  readonly person?: { readonly userId: string };
  readonly by: PrincipalRef;
};

export interface ConnectionCandidateListInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly envName: EnvName;
  readonly app?: string;
  /** That person's own connections instead of the company's. */
  readonly person?: { readonly userId: string };
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
  /**
   * The name for the connection it makes: trimmed, 1 to 100 characters,
   * with no hidden characters (`hasHiddenCharacters`).
   */
  readonly label?: string;
  /**
   * The connection to connect again: a live one of this connect's own
   * owner, on the same registration and environment. The same account is
   * required at the finish.
   */
  readonly reconnects?: string;
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

/** What a person's connect of another account did to their main one. */
export type ConnectFinishMain =
  | { readonly state: 'set' | 'kept'; readonly connectionId: string }
  | { readonly state: 'missing' };

export type ConnectFinishOutcome =
  | {
      readonly kind: 'connected';
      readonly request: ConnectRequestRecord;
      readonly connection: ConnectionRecord;
      /**
       * It landed on a connection that was already there: the one
       * `reconnects` named, or the owner's of the same account, the
       * company's or the person's. That connection keeps its name.
       */
      readonly reconnected?: boolean;
      /**
       * The name the new connection was to get (the one asked for, else the
       * account's label made to fit), when another connection had it: it's
       * named the first free `<name> 2`, `<name> 3`, and so on instead.
       */
      readonly labelTaken?: string;
      /**
       * A person's new connection of another account, when they already
       * had one through the registration: `set`, the one they had
       * (`connectionId`) is now their main; `kept`, `connectionId` stays
       * their main; `missing`, none of theirs is main, so they make one.
       * Absent for their first connection, a reconnect, and the company's.
       */
      readonly main?: ConnectFinishMain;
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
  /**
   * Renames it (`label`), or makes a person's connection their main one
   * (`main`), or both. A label another live connection of the same app,
   * owner and env has, by `comparableName` (names that look the same), is
   * `connection-label-taken`; a removed connection is
   * `connection-not-found`. `main` on a company connection is `bad-input`
   * (`main`); on a person's, their main one through the registration in
   * the env moves to it, in one step: the main already is answered as it
   * is. The route has already checked the caller is the person. A main
   * never moves a mail trigger: one stores its own connection.
   */
  update(input: {
    readonly tenantId: TenantId;
    readonly connectionId: string;
    /** Trimmed, 1 to 100 characters. */
    readonly label?: string;
    readonly main?: true;
    readonly by: PrincipalRef;
  }): Promise<Result<ConnectionRecord, ConnectionError>>;

  /**
   * The project's live choices in the env, oldest first, and with
   * `includeRemoved` the removed ones too. `agentId`, `flowId` and `app`
   * narrow it. A choice of a removed connection stays listed until it's
   * set again or removed.
   */
  listChoices(input: ConnectionChoiceListInput): Promise<ConnectionPage<ConnectionChoiceRecord>>;
  /** A choice by id, a removed one too. */
  getChoice(input: {
    readonly tenantId: TenantId;
    readonly choiceId: string;
  }): Promise<ConnectionChoiceRecord | null>;
  /**
   * Chooses a connection for the agent or flow, for the connection's app,
   * in the project and env: the company's choice, or with `person` that
   * person's own (the route has already checked the caller is the
   * person). The agent or flow must be one of the project's
   * (`agent-not-found`, `flow-not-found`). Each connection must be a
   * candidate (`listCandidates`, with `person` for a person's): a person's
   * in the company's choice is `bad-input`, and anything else that isn't
   * one is `connection-not-found`, the same answer as for an id that
   * doesn't exist. One that needs reconnecting may be chosen.
   *
   * With `toolId`, the choice is for that tool's need of the app
   * (`needs`): a tool the target has no need of the app for, an unknown
   * `need`, or one left out when the tool has two needs of the app, is
   * `bad-input`. The need's owner (`as`) must be the choice's: the
   * company's choice for a need that is each person's own, or a person's
   * for the company's, is `bad-input` (`person`), before the set is read.
   * Without `toolId`, the same holds for the target's tools that use the
   * app now: when every need of it is the other owner's, the choice is
   * `bad-input` (`person`); a target that doesn't use the app now may be
   * chosen for ahead.
   * `connectionIds` makes a set, only for a tool's need whose
   * `set.allowed` is true, with 2 to 10 different connections, every one
   * named (a label), `connectionId` among them: anything else is
   * `bad-input` (`connectionIds`).
   *
   * The same choice already live is answered as it is. Another removes
   * the live choice and makes a new one at the next version, in one step.
   */
  setChoice(
    input: ConnectionChoiceSetInput,
  ): Promise<Result<ConnectionChoiceRecord, ConnectionError>>;
  /**
   * Removes a live choice; it's kept, with `removedAt` and `removedBy`.
   * An unknown or removed one is `connection-choice-not-found`.
   */
  removeChoice(input: {
    readonly tenantId: TenantId;
    readonly choiceId: string;
    readonly by: PrincipalRef;
  }): Promise<Result<ConnectionChoiceRecord, ConnectionError>>;
  /**
   * The company connections a choice in the project may name: live
   * (working, or needing a reconnect), in the env, on a live registration
   * that allows the project. `app` narrows it. With `person`, that
   * person's own live connections through the registration the project
   * uses instead, with `main`.
   */
  listCandidates(
    input: ConnectionCandidateListInput,
  ): Promise<ConnectionPage<ConnectionCandidateRecord>>;
  /**
   * The agent's or flow's tools' needs of connections, at the versions
   * they resolve to now, each with whether a choice for it may be a set.
   * `app` narrows it. An agent or flow that isn't the project's is
   * `agent-not-found` or `flow-not-found`.
   */
  choiceNeeds(
    input: ConnectionChoiceTarget & {
      readonly tenantId: TenantId;
      readonly projectId: ProjectId;
      readonly envName: EnvName;
      readonly app?: string;
    },
  ): Promise<Result<ConnectionChoiceNeeds, ConnectionError>>;
  /**
   * The live choices in the env that name the connection: as their one
   * connection or a set's default (`connectionId`), or in a set
   * (`connectionIds`). Every project's, oldest first. A company
   * connection's are the company's choices; a person's, theirs.
   */
  listChoicesForConnection(input: {
    readonly tenantId: TenantId;
    readonly envName: EnvName;
    readonly connectionId: string;
    readonly limit: number;
    readonly cursor?: Cursor;
  }): Promise<ConnectionPage<ConnectionChoiceRecord>>;

  /**
   * A connect from outside a run (a Connect button, the CLI). A run's
   * connects are the resolver's. A person, like the company, keeps one
   * live connection per account on a registration and env, known only at
   * the finish: a connect that names none to reconnect connects the
   * account signed in to, another one too, or reconnects their connection
   * of that account. `reconnects` naming anything but a live connection of the connect's own
   * owner on that registration and env is `connection-not-found`, the same
   * answer as for an id that doesn't exist. A `label` another live
   * connection of the same app, owner and env has, by `comparableName`, is
   * `connection-label-taken`, unless the request reconnects: a reconnect
   * keeps the connection's label and doesn't check the one asked.
   */
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
   * A reconnect's connection is looked up again: while it's live, the same
   * account is required (`connection-account-mismatch`); one removed since
   * the request isn't reconnected, and the finish lands as a connect that
   * names none would. One that isn't a reconnect lands on the owner's live
   * connection of the account signed in to, when there is one, else makes
   * a new one: one account never has two. A reconnect's permissions are
   * both sets, and the outcome says `reconnected`.
   *
   * A person's new connection, when they already have one through the
   * registration in the env, keeps their main one (`main`): their first
   * becomes their main if none is, and with several and none main, none
   * is set and the outcome says so. Their first connection gets no main.
   *
   * A new connection's `label` is the request's, else the account's label
   * made to fit in 100 characters by `fitName`: its hidden characters
   * removed, trimmed, and cut between the characters a person sees. When
   * another live connection of the same app, owner and env has it by then,
   * by `comparableName`, it's the first free `<label> 2`, `<label> 3`, and
   * so on, and the outcome's `labelTaken` is the name it was to get: the
   * grant isn't wasted. A reconnect keeps the connection's label and
   * ignores the request's.
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
