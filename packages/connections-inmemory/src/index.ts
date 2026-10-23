// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An in-memory `ConnectionBinding` and `ConnectionResolver`, with a fake
 * app in place of Google's or GitHub's servers: for development and tests
 * only. It keeps everything in this process and refuses to start under
 * `NODE_ENV=production`.
 *
 * A connect finishes without a browser: start the request, read `state`
 * from its `authorizeUrl`, and finish with `code: 'ok'` (or
 * `error: 'access_denied'`). Tokens are `fake-<connectionId>-<n>`.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type ConnectWaitResult, computeConnectWaitToken } from '@kindgi/agents';
import type {
  ConnectFinishInput,
  ConnectFinishOutcome,
  ConnectRequestCreateInput,
  ConnectRequestInstallation,
  ConnectRequestRecord,
  ConnectionAppCreateInput,
  ConnectionAppRecord,
  ConnectionAppUpdateInput,
  ConnectionBinding,
  ConnectionError,
  ConnectionErrorCode,
  ConnectionListInput,
  ConnectionOwner,
  ConnectionPage,
  ConnectionRecord,
  ConnectionRemovedReason,
  ConnectionState,
  ConnectionWithdrawn,
} from '@kindgi/api';
import type { PrincipalRef } from '@kindgi/authz';
import { type AppEntry, SIGN_IN_TENANT_PATTERN } from '@kindgi/connections';
import {
  type ConnectionAccount,
  ConnectionRenewError,
  type ConnectionResolver,
  type ResolveConnectionsInput,
  type ResolveConnectionsOutcome,
  type ToolConnection,
  type WaitingForConnection,
} from '@kindgi/tools';
import type { Cursor, EnvName, ProjectId, Result, TenantId } from '@kindgi/types';

/** A connect request's life when no run waits for it, as a server's: an hour. */
const REQUEST_LIFE_MS = 60 * 60_000;
/** A sign-in's state: 10 minutes from its start. */
const STATE_LIFE_MS = 10 * 60_000;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
/** A token is renewed this close to its expiry: min(60 s, a fifth of its life), as a server's. */
const MAX_RENEW_MARGIN_MS = 60_000;
const HOUR_MS = 60 * 60_000;

/** What the fake app answers a code with. */
export interface FakeAppExchange {
  /** Whose account it is. A GitHub App's is the installation's, so this is ignored there. */
  readonly account: ConnectionAccount;
  /** The permissions granted. Absent: every one asked. */
  readonly granted?: readonly string[];
}

/** A notice the fake app sends, as `receiveNotice` reads it. */
export interface FakeNotice {
  /** What it was, for the answer: `'installation.deleted'`. */
  readonly handled: string;
  /** The account at the app it's about. */
  readonly accountId: string;
  /** What it does to that account's connections through the registration. Absent: nothing. */
  readonly action?: 'remove' | 'needs-reconnecting';
  /**
   * The `stateReason` a `needs-reconnecting` sets. Default: `'suspended'` for
   * a GitHub App, `'sessions-revoked'` for any other app.
   */
  readonly reason?: string;
}

/**
 * The fake app: how it answers each call. Absent hooks answer as an app
 * where everything works.
 */
export interface FakeApp {
  /**
   * A code, at the finish. Default: `'ok'` gives the owner's account (a
   * member's user id, or `company` for the company) and every permission
   * asked; any other code is refused (`connection-app-refused`).
   */
  exchange?(input: {
    readonly code: string;
    readonly request: ConnectRequestRecord;
  }): FakeAppExchange | 'refused';
  /**
   * A token's renewal. Default `'ok'`. `'invalid-grant'` marks the
   * connection `needs-reconnecting`; `'unavailable'` throws
   * `ConnectionRenewError` and leaves it as it is.
   */
  renew?(input: { readonly connectionId: string }): 'ok' | 'invalid-grant' | 'unavailable';
  /** A revoke, at a disconnect. Default `'ok'`. */
  withdraw?(input: { readonly connectionId: string }): 'ok' | 'failed';
  /**
   * A GitHub App's installations the person reaches. Default: one,
   * `'1'` on the account `acme`. None: a start goes to the install page.
   */
  installations?(input: {
    readonly tenantId: TenantId;
    readonly appId: string;
  }): readonly ConnectRequestInstallation[];
  /** A notice. Default: every notice is refused (`connection-notice-invalid`). */
  notice?(input: {
    readonly tenantId: TenantId;
    readonly appId: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly rawBody: Uint8Array;
  }): FakeNotice | 'invalid' | 'unavailable';
  /** How long a token lives. Default 3600. */
  readonly accessTokenTtlSeconds?: number;
}

/** One call to the fake app, in order. Never a token. */
export interface FakeAppCall {
  readonly op: 'exchange' | 'renew' | 'withdraw' | 'notice';
  readonly connectionId?: string;
  readonly requestId?: string;
  readonly outcome: string;
}

export interface InMemoryConnectionsOptions {
  /** The app entries the server knows: `[google, github]`. */
  readonly entries: readonly AppEntry[];
  /** The server's public URL, for `connectUrl`, `redirectUrl` and `noticesUrl`. */
  readonly publicUrl: string;
  /**
   * `true` allows `NODE_ENV=production`, for a parity test. Without it,
   * `createInMemoryConnections` throws there.
   */
  readonly productionSafe?: boolean;
  /** The clock, for tests. Default `Date.now`. */
  readonly now?: () => number;
  readonly app?: FakeApp;
  /**
   * A run's connect finished: what a server hands its waitpoint
   * (`completeToken`). Awaited inside the finish.
   */
  readonly onConnectComplete?: (input: {
    readonly tenantId: TenantId;
    readonly runId: string;
    readonly waitToken: string;
    readonly result: ConnectWaitResult;
  }) => Promise<void>;
}

/** A connection put in place without a connect. */
export interface SeedConnectionInput {
  readonly tenantId: TenantId;
  readonly envName: EnvName;
  readonly app: string;
  /** Which registration, when the tenant has more than one for the app. */
  readonly appId?: string;
  readonly owner: ConnectionOwner;
  readonly account: ConnectionAccount;
  readonly permissions: readonly string[];
  readonly state?: ConnectionState;
  readonly installationId?: string;
}

export interface InMemoryConnections {
  readonly binding: ConnectionBinding;
  readonly resolver: ConnectionResolver;
  /** Put a registration or a connection in place directly. Throws on input `createApp` would refuse. */
  readonly seed: {
    app(input: ConnectionAppCreateInput): ConnectionAppRecord;
    connection(input: SeedConnectionInput): ConnectionRecord;
  };
  /** Every call to the fake app, in order. */
  readonly calls: readonly FakeAppCall[];
}

interface StoredConnection {
  record: ConnectionRecord;
  token?: { readonly n: number; readonly expiresAtMs: number } | undefined;
}

interface StoredRequest {
  record: ConnectRequestRecord;
  /** The live sign-in: its state, usable once. */
  signIn?: { readonly state: string; readonly expiresAtMs: number } | undefined;
  /** A GitHub App's installation picked at the start. */
  picked?: string | undefined;
}

type Outcome<T> = Result<T, ConnectionError>;

type StartInput = Parameters<ConnectionBinding['startRequest']>[0];

type Need = NonNullable<ResolveConnectionsInput['needs'][string]>;

type Refused = Extract<ResolveConnectionsOutcome, { kind: 'refused' }>;

/** A connect a call waits for: one per connection, for every need of it. */
interface Wait {
  readonly names: string[];
  readonly entry: AppEntry;
  readonly app: ConnectionAppRecord;
  readonly owner: ConnectionOwner;
  readonly existing?: StoredConnection;
  permissions: string[];
}

type Resolved =
  | { readonly kind: 'ready'; readonly connection: ToolConnection }
  | { readonly kind: 'wait'; readonly wait: Wait }
  | Refused;

/** Who a code signed in as, and through which GitHub App installation. */
interface SignedIn {
  readonly account: ConnectionAccount;
  readonly installationId: string | undefined;
}

function ok<T>(value: T): Outcome<T> {
  return { kind: 'ok', value };
}

function refuse(
  code: ConnectionErrorCode,
  message: string,
  more: { readonly field?: string; readonly connectRequestId?: string } = {},
): Outcome<never> {
  return { kind: 'err', error: { code, message, ...more } };
}

function principalKey(p: PrincipalRef): string {
  return `${p.kind}:${p.id}`;
}

function ownerKey(owner: ConnectionOwner): string {
  return owner.kind === 'member' ? `member:${owner.userId}` : 'company';
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function page<T>(items: readonly T[], limit: number, cursor?: Cursor): ConnectionPage<T> {
  const from = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const start = Number.isSafeInteger(from) && from > 0 ? from : 0;
  const data = items.slice(start, start + limit);
  const next = start + data.length;
  return { data, ...(next < items.length && { nextCursor: String(next) as Cursor }) };
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The in-memory binding and resolver, sharing one store, with a fake app.
 * See the module comment for how a test finishes a connect.
 */
export function createInMemoryConnections(
  options: InMemoryConnectionsOptions,
): InMemoryConnections {
  if (!options.productionSafe && process.env.NODE_ENV === 'production') {
    throw new Error(
      '@kindgi/connections-inmemory refuses to start with NODE_ENV=production; supply { productionSafe: true } if this is a parity test.',
    );
  }
  const now = options.now ?? (() => Date.now());
  const iso = (ms: number = now()): string => new Date(ms).toISOString();
  const publicUrl = options.publicUrl.replace(/\/+$/, '');
  const fake: FakeApp = options.app ?? {};
  const ttlMs = (fake.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS) * 1000;
  const entries = new Map(options.entries.map((entry) => [entry.id, entry]));
  const apps = new Map<string, ConnectionAppRecord>();
  const connections = new Map<string, StoredConnection>();
  const requests = new Map<string, StoredRequest>();
  const calls: FakeAppCall[] = [];

  // ---------------- registrations ----------------

  function checkSignIn(
    entry: AppEntry,
    input: Pick<ConnectionAppCreateInput, 'oauth2' | 'githubApp'>,
    mode: 'create' | 'update',
  ): Outcome<true> {
    const oauth2 = entry.signIn.kind === 'oauth2';
    if (oauth2 && input.githubApp !== undefined) {
      return refuse(
        'connection-app-invalid',
        `${entry.name} signs in with OAuth 2.0: give \`oauth2\``,
        { field: 'githubApp' },
      );
    }
    if (!oauth2 && input.oauth2 !== undefined) {
      return refuse('connection-app-invalid', `${entry.name} is a GitHub App: give \`githubApp\``, {
        field: 'oauth2',
      });
    }
    if (mode === 'create' && oauth2 && input.oauth2 === undefined) {
      return refuse('connection-app-invalid', `${entry.name} needs \`oauth2\``, {
        field: 'oauth2',
      });
    }
    if (mode === 'create' && !oauth2 && input.githubApp === undefined) {
      return refuse('connection-app-invalid', `${entry.name} needs \`githubApp\``, {
        field: 'githubApp',
      });
    }
    return input.oauth2 === undefined ? ok(true) : checkTenant(entry, input.oauth2.tenant);
  }

  /**
   * A registration's directory: refused for an entry whose sign-in names
   * none, needed when it has no default, and a name its URLs can hold.
   */
  function checkTenant(entry: AppEntry, tenant: string | undefined): Outcome<true> {
    const named = entry.signIn.kind === 'oauth2' ? entry.signIn.tenant : undefined;
    const at = { field: 'oauth2.tenant' };
    if (named === undefined) {
      return tenant === undefined
        ? ok(true)
        : refuse(
            'connection-app-invalid',
            `${entry.name} signs in at no directory: leave out \`oauth2.tenant\``,
            at,
          );
    }
    if (tenant === undefined) {
      return named.default !== undefined
        ? ok(true)
        : refuse(
            'connection-app-invalid',
            `${entry.name} needs \`oauth2.tenant\`: the directory its app signs people in at`,
            at,
          );
    }
    return SIGN_IN_TENANT_PATTERN.test(tenant)
      ? ok(true)
      : refuse(
          'connection-app-invalid',
          `\`oauth2.tenant\` must match ${SIGN_IN_TENANT_PATTERN.source}`,
          at,
        );
  }

  function createApp(input: ConnectionAppCreateInput): Outcome<ConnectionAppRecord> {
    const entry = entries.get(input.app);
    if (entry === undefined) {
      return refuse('connection-app-unknown-entry', `No app entry "${input.app}" on this server`, {
        field: 'app',
      });
    }
    const checked = checkSignIn(entry, input, 'create');
    if (checked.kind === 'err') return checked;
    const appId = randomUUID();
    const at = iso();
    const record: ConnectionAppRecord = {
      appId,
      tenantId: input.tenantId,
      app: input.app,
      ...(input.label !== undefined && { label: input.label }),
      ...(input.oauth2 !== undefined && { oauth2: input.oauth2 }),
      ...(input.githubApp !== undefined && { githubApp: input.githubApp }),
      ...(input.projects !== undefined && { projects: [...input.projects] }),
      redirectUrl: `${publicUrl}/console/connect/callback`,
      noticesUrl: `${publicUrl}/v1/connection-notices/${input.tenantId}/${appId}`,
      createdAt: at,
      updatedAt: at,
    };
    apps.set(appId, record);
    return ok(record);
  }

  function liveApp(tenantId: TenantId, appId: string): ConnectionAppRecord | undefined {
    const app = apps.get(appId);
    return app !== undefined && app.tenantId === tenantId && app.removedAt === undefined
      ? app
      : undefined;
  }

  function allows(app: ConnectionAppRecord, projectId: ProjectId | undefined): boolean {
    return (
      projectId === undefined || app.projects === undefined || app.projects.includes(projectId)
    );
  }

  /** The tenant's live registrations of an app that allow the project, oldest first. */
  function registrationsFor(
    tenantId: TenantId,
    app: string,
    projectId: ProjectId | undefined,
  ): ConnectionAppRecord[] {
    return [...apps.values()]
      .filter(
        (a) =>
          a.tenantId === tenantId &&
          a.app === app &&
          a.removedAt === undefined &&
          allows(a, projectId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---------------- connections ----------------

  function liveConnection(
    tenantId: TenantId,
    appId: string,
    owner: ConnectionOwner,
    envName: EnvName,
  ): StoredConnection | undefined {
    const key = ownerKey(owner);
    for (const stored of connections.values()) {
      const c = stored.record;
      if (
        c.tenantId === tenantId &&
        c.appId === appId &&
        c.envName === envName &&
        ownerKey(c.owner) === key &&
        c.state !== 'removed'
      ) {
        return stored;
      }
    }
    return undefined;
  }

  function issueToken(stored: StoredConnection): void {
    stored.token = { n: (stored.token?.n ?? 0) + 1, expiresAtMs: now() + ttlMs };
  }

  function withdrawAtApp(stored: StoredConnection): ConnectionWithdrawn {
    const c = stored.record;
    const removal = entries.get(c.app)?.removal;
    if (removal?.revoke !== 'oauth2-revoke') return 'not-supported';
    if (removal.revokeIsGrantWide === true) {
      for (const other of connections.values()) {
        const o = other.record;
        if (
          o.connectionId !== c.connectionId &&
          o.tenantId === c.tenantId &&
          o.appId === c.appId &&
          o.account.id === c.account.id &&
          o.state !== 'removed'
        ) {
          return 'kept-for-other-connection';
        }
      }
    }
    const answer = fake.withdraw?.({ connectionId: c.connectionId }) ?? 'ok';
    calls.push({ op: 'withdraw', connectionId: c.connectionId, outcome: answer });
    return answer === 'ok' ? 'at-app' : 'app-failed';
  }

  function remove(
    stored: StoredConnection,
    by: string,
    reason: ConnectionRemovedReason,
    withdrawn: ConnectionWithdrawn,
  ): ConnectionRecord {
    const at = iso();
    stored.record = {
      ...stored.record,
      state: 'removed',
      removedAt: at,
      removedBy: by,
      removedReason: reason,
      withdrawn,
      updatedAt: at,
    };
    stored.token = undefined;
    return stored.record;
  }

  // ---------------- connect requests ----------------

  function refreshed(stored: StoredRequest): ConnectRequestRecord {
    if (stored.record.state === 'pending' && now() >= Date.parse(stored.record.expiresAt)) {
      stored.record = { ...stored.record, state: 'expired' };
      stored.signIn = undefined;
    }
    return stored.record;
  }

  function newRequest(input: {
    readonly tenantId: TenantId;
    readonly envName: EnvName;
    readonly app: ConnectionAppRecord;
    readonly entry: AppEntry;
    readonly owner: ConnectionOwner;
    readonly permissions: readonly string[];
    readonly reconnects?: string;
    readonly run?: { readonly runId: string; readonly waitToken: string; readonly name: string };
    readonly expiresAtMs: number;
    readonly createdBy: string;
  }): ConnectRequestRecord {
    const requestId = randomUUID();
    const record: ConnectRequestRecord = {
      requestId,
      tenantId: input.tenantId,
      envName: input.envName,
      appId: input.app.appId,
      app: input.entry.id,
      owner: input.owner,
      permissions: input.permissions,
      says: input.permissions.map((p) => input.entry.permissions[p]?.says ?? p),
      ...(input.reconnects !== undefined && { reconnects: input.reconnects }),
      ...(input.run !== undefined && input.run),
      state: 'pending',
      connectUrl: `${publicUrl}/console/connect/${requestId}`,
      expiresAt: iso(input.expiresAtMs),
      createdAt: iso(),
      createdBy: input.createdBy,
    };
    requests.set(requestId, { record });
    return record;
  }

  /** Who may own it, and what it asks for: the entry's. */
  function checkAsked(entry: AppEntry, input: ConnectRequestCreateInput): Outcome<true> {
    if (!entry.owners.includes(input.owner.kind)) {
      const whose = entry.owners.map((o) => (o === 'member' ? "a member's" : "the company's"));
      return refuse('bad-input', `${entry.name} connects only ${whose.join(' or ')} account`, {
        field: 'for',
      });
    }
    if (input.permissions.length === 0) {
      return refuse('bad-input', 'Ask for at least one permission', { field: 'permissions' });
    }
    const unknown = input.permissions.find((p) => entry.permissions[p] === undefined);
    if (unknown !== undefined) {
      return refuse('bad-input', `${entry.name} has no permission "${unknown}"`, {
        field: 'permissions',
      });
    }
    return ok(true);
  }

  /** The registration a connect goes through: the one named, or the tenant's only one. */
  function registrationFor(
    entry: AppEntry,
    input: ConnectRequestCreateInput,
  ): Outcome<ConnectionAppRecord> {
    const found =
      input.appId !== undefined
        ? [liveApp(input.tenantId, input.appId)].filter(
            (a): a is ConnectionAppRecord =>
              a !== undefined && a.app === input.app && allows(a, input.projectId),
          )
        : registrationsFor(input.tenantId, input.app, input.projectId);
    if (found.length > 1) {
      return refuse(
        'bad-input',
        `The company has more than one registration of ${entry.name}: give \`appId\``,
        { field: 'appId' },
      );
    }
    const [app] = found;
    return app === undefined
      ? refuse('connection-app-not-found', `No registration of ${entry.name} for this`)
      : ok(app);
  }

  function createRequest(input: ConnectRequestCreateInput): Outcome<ConnectRequestRecord> {
    const entry = entries.get(input.app);
    if (entry === undefined) {
      return refuse('connection-app-unknown-entry', `No app entry "${input.app}" on this server`, {
        field: 'app',
      });
    }
    const asked = checkAsked(entry, input);
    if (asked.kind === 'err') return asked;
    const app = registrationFor(entry, input);
    if (app.kind === 'err') return app;
    const existing = liveConnection(input.tenantId, app.value.appId, input.owner, input.envName);
    return ok(
      newRequest({
        tenantId: input.tenantId,
        envName: input.envName,
        app: app.value,
        entry,
        owner: input.owner,
        permissions: union(input.permissions, existing?.record.permissions ?? []),
        ...(existing !== undefined && { reconnects: existing.record.connectionId }),
        expiresAtMs: now() + REQUEST_LIFE_MS,
        createdBy: principalKey(input.by),
      }),
    );
  }

  function installationsOf(
    tenantId: TenantId,
    appId: string,
  ): readonly ConnectRequestInstallation[] {
    return (
      fake.installations?.({ tenantId, appId }) ?? [
        { installationId: '1', account: { id: '1', label: 'acme' } },
      ]
    );
  }

  /** A request still open to a start: pending, and within its life. */
  function openRequest(stored: StoredRequest): Outcome<ConnectRequestRecord> {
    const request = refreshed(stored);
    if (request.state === 'expired') {
      return refuse('connection-request-expired', 'The connect request expired');
    }
    if (request.state !== 'pending') {
      return refuse('connection-request-used', 'The connect request was finished already');
    }
    return ok(request);
  }

  /** A GitHub App's pick: either field, never both, and on a GitHub App only. */
  function checkPick(entry: AppEntry, input: StartInput): Outcome<true> {
    for (const field of ['installationId', 'newInstallation'] as const) {
      if (entry.signIn.kind !== 'github-app' && input[field] !== undefined) {
        return refuse('bad-input', `\`${field}\` is a GitHub App's only`, { field });
      }
    }
    if (input.installationId !== undefined && input.newInstallation === true) {
      return refuse(
        'bad-input',
        '`newInstallation` installs the app on another account: leave out `installationId`',
        { field: 'newInstallation' },
      );
    }
    return ok(true);
  }

  /**
   * An OAuth app's authorize page, in the registration's directory when the
   * sign-in names one: the sign-in's and the account's scopes and each
   * permission's grants, with PKCE.
   */
  function oauth2Url(
    entry: AppEntry,
    signIn: Extract<AppEntry['signIn'], { kind: 'oauth2' }>,
    app: ConnectionAppRecord,
    request: ConnectRequestRecord,
  ): URL {
    // Filled in the text: `new URL` would percent-encode the braces.
    const tenant = app.oauth2?.tenant ?? signIn.tenant?.default;
    const url = new URL(
      tenant === undefined ? signIn.authorizeUrl : signIn.authorizeUrl.replace('{tenant}', tenant),
    );
    const scopes = [
      ...(signIn.scopes ?? []),
      ...(entry.account.kind === 'github-installation' ? [] : entry.account.scopes),
      ...request.permissions.map((p) => entry.permissions[p]?.grants ?? p),
    ];
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', app.oauth2?.clientId ?? '');
    url.searchParams.set('redirect_uri', app.redirectUrl);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('code_challenge', challengeOf(randomBytes(32).toString('base64url')));
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [key, value] of Object.entries(signIn.authorizeParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  /** A GitHub App's install page when asked or when it has none, else GitHub's sign-in. */
  function githubUrl(
    app: ConnectionAppRecord,
    request: ConnectRequestRecord,
    newInstallation: boolean,
  ): URL {
    if (newInstallation || installationsOf(request.tenantId, request.appId).length === 0) {
      return new URL(`https://github.com/apps/${app.githubApp?.slug ?? ''}/installations/new`);
    }
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', app.githubApp?.clientId ?? '');
    url.searchParams.set('redirect_uri', app.redirectUrl);
    return url;
  }

  /** The app's page to send the person to, carrying `state`. */
  function authorizeUrl(
    entry: AppEntry,
    app: ConnectionAppRecord,
    request: ConnectRequestRecord,
    state: string,
    newInstallation: boolean,
  ): string {
    const url =
      entry.signIn.kind === 'oauth2'
        ? oauth2Url(entry, entry.signIn, app, request)
        : githubUrl(app, request, newInstallation);
    url.searchParams.set('state', state);
    return url.toString();
  }

  function startRequest(input: StartInput): Outcome<{ readonly authorizeUrl: string }> {
    const stored = requests.get(input.requestId);
    if (stored === undefined || stored.record.tenantId !== input.tenantId) {
      return refuse('connection-request-not-found', 'No such connect request');
    }
    const request = openRequest(stored);
    if (request.kind === 'err') return request;
    const entry = entries.get(request.value.app) as AppEntry;
    const app = liveApp(request.value.tenantId, request.value.appId);
    if (app === undefined) {
      return refuse('connection-app-not-found', 'The registration was removed');
    }
    const pick = checkPick(entry, input);
    if (pick.kind === 'err') return pick;
    const state = randomBytes(32).toString('base64url');
    stored.signIn = { state, expiresAtMs: now() + STATE_LIFE_MS };
    stored.picked = input.installationId;
    stored.record = { ...request.value, startedBy: principalKey(input.caller) };
    return ok({
      authorizeUrl: authorizeUrl(entry, app, request.value, state, input.newInstallation === true),
    });
  }

  async function settle(
    stored: StoredRequest,
    change: Partial<ConnectRequestRecord> & { readonly state: ConnectRequestRecord['state'] },
    result?: ConnectWaitResult,
  ): Promise<ConnectRequestRecord> {
    const { installations: _offered, ...rest } = stored.record;
    stored.record = { ...rest, ...change };
    stored.signIn = undefined;
    stored.picked = undefined;
    const { runId, waitToken } = stored.record;
    if (result !== undefined && runId !== undefined && waitToken !== undefined) {
      await options.onConnectComplete?.({
        tenantId: stored.record.tenantId,
        runId,
        waitToken,
        result,
      });
    }
    return stored.record;
  }

  /** The request a finish is for, still open to it, and by whoever started it. */
  function finishable(input: ConnectFinishInput): Outcome<StoredRequest> {
    const stored = [...requests.values()].find(
      (r) => r.record.tenantId === input.tenantId && r.signIn?.state === input.state,
    );
    if (stored === undefined) {
      return refuse('connection-request-not-found', 'No connect request for that state');
    }
    if (stored.record.startedBy !== principalKey(input.caller)) {
      return refuse('connection-not-yours', 'Only whoever started the connect may finish it');
    }
    const open = openRequest(stored);
    if (open.kind === 'err') return open;
    if (now() >= (stored.signIn?.expiresAtMs ?? 0)) {
      return refuse('connection-state-expired', 'The sign-in took too long: start again');
    }
    if (input.error === undefined && input.code === undefined && !awaitsOwner(stored, input)) {
      return refuse('bad-input', 'Give the `code` the app sent back, or its `error`', {
        field: 'code',
      });
    }
    return ok(stored);
  }

  /** A GitHub App install that waits for an organization owner's approval on GitHub. */
  function awaitsOwner(stored: StoredRequest, input: ConnectFinishInput): boolean {
    return (
      input.setupAction === 'request' &&
      entries.get(stored.record.app)?.signIn.kind === 'github-app'
    );
  }

  /** The app's `error` instead of a code: declined when the person said no. */
  async function finishWithError(
    stored: StoredRequest,
    error: string,
  ): Promise<Outcome<ConnectFinishOutcome>> {
    if (error === 'access_denied') {
      return ok({
        kind: 'declined',
        request: await settle(stored, { state: 'declined' }, { kind: 'declined' }),
      });
    }
    await settle(stored, { state: 'failed', failure: 'app-refused' });
    return refuse('connection-app-refused', `The app answered "${error}"`);
  }

  /** The fake app's answer to the code: `ok` signs in as the owner. */
  function exchangeCode(request: ConnectRequestRecord, code: string): FakeAppExchange | 'refused' {
    const exchanged =
      fake.exchange?.({ code, request }) ??
      (code === 'ok'
        ? {
            account:
              request.owner.kind === 'member'
                ? { id: request.owner.userId, label: request.owner.userId }
                : { id: 'company', label: 'company' },
          }
        : 'refused');
    calls.push({
      op: 'exchange',
      requestId: request.requestId,
      outcome: exchanged === 'refused' ? 'refused' : 'ok',
    });
    return exchanged;
  }

  /**
   * A GitHub App's installation the finish connects through: the one
   * picked, or the only one the person reaches; several and none picked
   * gives them to pick from.
   */
  function installationFor(
    request: ConnectRequestRecord,
    chosen: string | undefined,
  ): Outcome<
    ConnectRequestInstallation | { readonly pick: readonly ConnectRequestInstallation[] }
  > {
    const reachable = installationsOf(request.tenantId, request.appId);
    if (chosen === undefined && reachable.length > 1) return ok({ pick: reachable });
    const found =
      chosen !== undefined ? reachable.find((i) => i.installationId === chosen) : reachable[0];
    if (found === undefined) {
      return refuse(
        'connection-installation-unreachable',
        "Your GitHub account doesn't reach an installation of the app: install it on your account (`newInstallation`)",
        { connectRequestId: request.requestId },
      );
    }
    return ok(found);
  }

  /** The connection a finish makes or reconnects, with what was granted. */
  function storeConnection(
    request: ConnectRequestRecord,
    live: StoredConnection | undefined,
    made: SignedIn & { readonly granted: readonly string[] },
  ): StoredConnection {
    const at = iso();
    const installation = made.installationId !== undefined && {
      installationId: made.installationId,
    };
    if (live !== undefined) {
      const { stateReason: _reason, ...rest } = live.record;
      live.record = {
        ...rest,
        account: made.account,
        permissions: union(live.record.permissions, made.granted),
        state: 'working',
        ...installation,
        connectedAt: at,
        updatedAt: at,
      };
      return live;
    }
    const connection: StoredConnection = {
      record: {
        connectionId: randomUUID(),
        tenantId: request.tenantId,
        envName: request.envName,
        appId: request.appId,
        app: request.app,
        owner: request.owner,
        account: made.account,
        permissions: made.granted,
        state: 'working',
        ...installation,
        connectedAt: at,
        createdAt: at,
        createdBy: request.startedBy ?? request.createdBy,
        updatedAt: at,
      },
    };
    connections.set(connection.record.connectionId, connection);
    return connection;
  }

  /**
   * A grant that lacks some of what the connection holds is let go. The
   * request is connected to the connection when it works and holds all the
   * request asks; otherwise it declines for all it would have needed.
   */
  async function keepAsItWas(
    stored: StoredRequest,
    live: StoredConnection,
    kept: readonly string[],
  ): Promise<Outcome<ConnectFinishOutcome>> {
    const request = stored.record;
    const held = live.record.permissions;
    const connectionId = live.record.connectionId;
    if (live.record.state === 'working' && request.permissions.every((p) => held.includes(p))) {
      return ok({
        kind: 'connected',
        request: await settle(
          stored,
          { state: 'connected', connectionId },
          { kind: 'connected', connectionId },
        ),
        connection: live.record,
      });
    }
    const missing = union(request.permissions, held).filter((p) => !kept.includes(p));
    return ok({
      kind: 'declined',
      request: await settle(stored, { state: 'declined', missing }, { kind: 'declined', missing }),
    });
  }

  /** The working connection a finish lands on: the one it reconnects, or the owner's. */
  function landsOn(request: ConnectRequestRecord): StoredConnection | undefined {
    const target =
      (request.reconnects !== undefined ? connections.get(request.reconnects) : undefined) ??
      liveConnection(request.tenantId, request.appId, request.owner, request.envName);
    return target !== undefined && target.record.state !== 'removed' ? target : undefined;
  }

  /**
   * The account a code signed in as; a GitHub App's is the installation's,
   * or the installations to pick from.
   */
  function accountFor(
    stored: StoredRequest,
    exchanged: FakeAppExchange,
    chosen: string | undefined,
  ): Outcome<SignedIn | ConnectFinishOutcome> {
    const request = stored.record;
    if (entries.get(request.app)?.signIn.kind !== 'github-app') {
      return ok({ account: exchanged.account, installationId: undefined });
    }
    const installation = installationFor(request, chosen);
    if (installation.kind === 'err') return installation;
    if ('pick' in installation.value) {
      stored.record = { ...request, installations: installation.value.pick };
      return ok({ kind: 'pick-installation', request: stored.record });
    }
    return ok({
      account: installation.value.account,
      installationId: installation.value.installationId,
    });
  }

  /**
   * Makes the connection with what the person granted, declining for what's
   * missing; or reconnects it. A reconnect never narrows: a grant that covers
   * all the connection holds now is stored (so one that needs reconnecting
   * works again); one that lacks any of it leaves the connection as it was,
   * and the request is connected to it only if it works and holds all asked.
   * A decline always names what's missing.
   */
  async function connect(
    stored: StoredRequest,
    granted: readonly string[] | undefined,
    signedIn: SignedIn,
  ): Promise<Outcome<ConnectFinishOutcome>> {
    const request = stored.record;
    const live = landsOn(request);
    if (live !== undefined && live.record.account.id !== signedIn.account.id) {
      await settle(stored, { state: 'failed', failure: 'account-mismatch' });
      return refuse(
        'connection-account-mismatch',
        `That's another account: reconnect ${live.record.account.label}`,
      );
    }
    // What the connection holds now: it may have gained permissions since the request was made.
    const held = live?.record.permissions ?? [];
    const known = union(request.permissions, held);
    const kept = (granted ?? request.permissions).filter((p) => known.includes(p));
    if (live !== undefined && !held.every((p) => kept.includes(p))) {
      return keepAsItWas(stored, live, kept);
    }
    const missing = request.permissions.filter((p) => !kept.includes(p));
    if (kept.length === 0) {
      return ok({
        kind: 'declined',
        request: await settle(
          stored,
          { state: 'declined', missing },
          { kind: 'declined', missing },
        ),
      });
    }
    const connection = storeConnection(request, live, { ...signedIn, granted: kept });
    issueToken(connection);
    const connectionId = connection.record.connectionId;
    if (missing.length > 0) {
      return ok({
        kind: 'declined',
        request: await settle(
          stored,
          { state: 'declined', missing, connectionId },
          { kind: 'declined', missing },
        ),
      });
    }
    return ok({
      kind: 'connected',
      request: await settle(
        stored,
        { state: 'connected', connectionId },
        { kind: 'connected', connectionId },
      ),
      connection: connection.record,
    });
  }

  async function finishRequest(input: ConnectFinishInput): Promise<Outcome<ConnectFinishOutcome>> {
    const found = finishable(input);
    if (found.kind === 'err') return found;
    const stored = found.value;
    const picked = stored.picked;
    stored.signIn = undefined;
    stored.picked = undefined;
    if (input.error !== undefined) return finishWithError(stored, input.error);
    if (awaitsOwner(stored, input)) {
      await settle(stored, { state: 'failed', failure: 'app-refused' });
      return refuse(
        'connection-app-refused',
        'The install waits for an organization owner to approve it on GitHub: start again once they have',
      );
    }
    const exchanged = exchangeCode(stored.record, input.code as string);
    if (exchanged === 'refused') {
      await settle(stored, { state: 'failed', failure: 'app-refused' });
      return refuse('connection-app-refused', "The app wouldn't give a token for the code");
    }
    const signedIn = accountFor(stored, exchanged, input.installationId ?? picked);
    if (signedIn.kind === 'err') return signedIn;
    if ('kind' in signedIn.value) return ok(signedIn.value);
    return connect(stored, exchanged.granted, signedIn.value);
  }

  /** The list's own filters: app, state and owner. */
  function matchesAsked(c: ConnectionRecord, input: ConnectionListInput): boolean {
    if (input.app !== undefined && c.app !== input.app) return false;
    if (input.state !== undefined && c.state !== input.state) return false;
    if (input.ownerKind !== undefined && c.owner.kind !== input.ownerKind) return false;
    return (
      input.ownerUserId === undefined ||
      (c.owner.kind === 'member' && c.owner.userId === input.ownerUserId)
    );
  }

  /** Whether a list shows the connection: its filters, and the project's registrations. */
  function listed(c: ConnectionRecord, input: ConnectionListInput): boolean {
    if (c.tenantId !== input.tenantId) return false;
    if (input.includeRemoved !== true && c.state === 'removed') return false;
    if (!matchesAsked(c, input)) return false;
    if (input.projectId === undefined) return true;
    const app = apps.get(c.appId);
    return app !== undefined && allows(app, input.projectId);
  }

  /** What a notice does to one of the account's connections. */
  function applyNotice(stored: StoredConnection, app: ConnectionAppRecord, notice: FakeNotice) {
    if (notice.action === 'remove') {
      const uninstalled = entries.get(app.app)?.signIn.kind === 'github-app';
      remove(stored, `app:${app.appId}`, uninstalled ? 'uninstalled' : 'revoked-at-app', 'at-app');
      return;
    }
    const github = entries.get(app.app)?.signIn.kind === 'github-app';
    stored.record = {
      ...stored.record,
      state: 'needs-reconnecting',
      stateReason: notice.reason ?? (github ? 'suspended' : 'sessions-revoked'),
      updatedAt: iso(),
    };
    stored.token = undefined;
  }

  /** The fake app's reading of a notice, recorded as a call. */
  function readNotice(
    app: ConnectionAppRecord | undefined,
    input: Parameters<ConnectionBinding['receiveNotice']>[0],
  ): Outcome<FakeNotice> {
    const notice = app !== undefined ? fake.notice?.(input) : undefined;
    const read = notice ?? 'invalid';
    calls.push({ op: 'notice', outcome: typeof read === 'string' ? read : read.handled });
    if (read === 'unavailable') {
      return refuse('connection-notice-unavailable', "The notice can't be handled just now");
    }
    if (read === 'invalid') {
      return refuse('connection-notice-invalid', 'The notice was not accepted');
    }
    return ok(read);
  }

  // ---------------- the binding ----------------

  const binding: ConnectionBinding = {
    entries: () => options.entries,

    async listApps(input) {
      const data = [...apps.values()]
        .filter(
          (a) =>
            a.tenantId === input.tenantId &&
            (input.includeRemoved === true || a.removedAt === undefined),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.appId.localeCompare(b.appId));
      return page(data, input.limit, input.cursor);
    },

    async getApp(input) {
      const app = apps.get(input.appId);
      return app !== undefined && app.tenantId === input.tenantId ? app : null;
    },

    async createApp(input) {
      return createApp(input);
    },

    async updateApp(input: ConnectionAppUpdateInput) {
      const app = liveApp(input.tenantId, input.appId);
      if (app === undefined) return refuse('connection-app-not-found', 'No such registration');
      const checked = checkSignIn(entries.get(app.app) as AppEntry, input, 'update');
      if (checked.kind === 'err') return checked;
      const { projects: _projects, ...rest } = app;
      const updated: ConnectionAppRecord = {
        ...rest,
        ...(input.label !== undefined && { label: input.label }),
        ...(input.oauth2 !== undefined && { oauth2: input.oauth2 }),
        ...(input.githubApp !== undefined && { githubApp: input.githubApp }),
        ...(input.projects === undefined
          ? app.projects !== undefined && { projects: app.projects }
          : input.projects !== null && { projects: [...input.projects] }),
        updatedAt: iso(),
      };
      apps.set(app.appId, updated);
      return ok(updated);
    },

    async removeApp(input) {
      const app = liveApp(input.tenantId, input.appId);
      if (app === undefined) return refuse('connection-app-not-found', 'No such registration');
      const live = [...connections.values()].filter(
        (c) => c.record.appId === app.appId && c.record.state !== 'removed',
      );
      if (!input.withConnections && live.length > 0) {
        return refuse(
          'connection-app-in-use',
          `${live.length} connection(s) still use the registration: remove them with it, or first`,
        );
      }
      for (const stored of live) {
        remove(stored, principalKey(input.by), 'registration-removed', withdrawAtApp(stored));
      }
      const at = iso();
      apps.set(app.appId, { ...app, removedAt: at, updatedAt: at });
      return ok({ connectionsRemoved: live.length });
    },

    async list(input: ConnectionListInput) {
      const data = [...connections.values()]
        .map((s) => s.record)
        .filter((c) => listed(c, input))
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.connectionId.localeCompare(b.connectionId),
        );
      return page(data, input.limit, input.cursor);
    },

    async get(input) {
      const stored = connections.get(input.connectionId);
      return stored !== undefined && stored.record.tenantId === input.tenantId
        ? stored.record
        : null;
    },

    async disconnect(input) {
      const stored = connections.get(input.connectionId);
      if (stored === undefined || stored.record.tenantId !== input.tenantId) {
        return refuse('connection-not-found', 'No such connection');
      }
      if (stored.record.state === 'removed') return ok(stored.record);
      return ok(remove(stored, principalKey(input.by), 'disconnected', withdrawAtApp(stored)));
    },

    async createRequest(input) {
      return createRequest(input);
    },

    async getRequest(input) {
      const stored = requests.get(input.requestId);
      return stored !== undefined && stored.record.tenantId === input.tenantId
        ? refreshed(stored)
        : null;
    },

    async requestsForRun(input) {
      return [...requests.values()]
        .filter((s) => s.record.tenantId === input.tenantId && s.record.runId === input.runId)
        .map(refreshed)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async startRequest(input) {
      return startRequest(input);
    },

    finishRequest,

    async receiveNotice(input) {
      const app = liveApp(input.tenantId, input.appId);
      const read = readNotice(app, input);
      if (read.kind === 'err') return read;
      const notice = read.value;
      if (app === undefined || notice.action === undefined) {
        return ok({ handled: notice.handled, connections: 0 });
      }
      const affected = [...connections.values()].filter(
        (c) =>
          c.record.appId === app.appId &&
          c.record.account.id === notice.accountId &&
          c.record.state !== 'removed',
      );
      for (const stored of affected) applyNotice(stored, app, notice);
      return ok({ handled: notice.handled, connections: affected.length });
    },
  };

  // ---------------- the resolver ----------------

  /** The connection's token for one call, renewed first when asked or near its expiry. */
  function tokenFor(
    stored: StoredConnection,
    name: string,
    renewFirst: boolean,
  ): ToolConnection | 'invalid-grant' {
    const c = stored.record;
    const token = stored.token;
    const margin = Math.min(MAX_RENEW_MARGIN_MS, ttlMs / 5);
    if (renewFirst || token === undefined || now() >= token.expiresAtMs - margin) {
      const answer = fake.renew?.({ connectionId: c.connectionId }) ?? 'ok';
      calls.push({ op: 'renew', connectionId: c.connectionId, outcome: answer });
      if (answer === 'unavailable') throw new ConnectionRenewError(name);
      if (answer === 'invalid-grant') {
        stored.record = {
          ...c,
          state: 'needs-reconnecting',
          stateReason: 'invalid-grant',
          updatedAt: iso(),
        };
        stored.token = undefined;
        return 'invalid-grant';
      }
      issueToken(stored);
    }
    const issued = stored.token as NonNullable<StoredConnection['token']>;
    stored.record = { ...stored.record, lastUsedAt: iso(Math.floor(now() / HOUR_MS) * HOUR_MS) };
    return {
      connectionId: c.connectionId,
      app: c.app,
      appName: entries.get(c.app)?.name ?? c.app,
      accessToken: `fake-${c.connectionId}-${issued.n}`,
      account: c.account,
      expiresAt: iso(issued.expiresAtMs),
    };
  }

  function ownerFor(
    name: string,
    need: Need,
    entry: AppEntry,
    input: ResolveConnectionsInput,
  ): ConnectionOwner | Refused {
    if (need.as !== 'person') return { kind: 'company' };
    if (input.person === undefined) {
      return {
        kind: 'refused',
        code: 'connection-needs-a-person',
        name,
        app: need.app,
        message: `"${name}" is a person's ${entry.name} connection, and no person runs this`,
      };
    }
    return { kind: 'member', userId: input.person.userId };
  }

  function missingRefusal(
    name: string,
    entry: AppEntry,
    existing: StoredConnection | undefined,
    lacks: readonly string[],
  ): Refused {
    return {
      kind: 'refused',
      code: 'connection-missing',
      name,
      app: entry.id,
      ...(lacks.length > 0 && { missing: lacks }),
      message:
        existing === undefined
          ? `"${name}" needs a ${entry.name} connection, and there's none`
          : lacks.length > 0
            ? `"${name}"'s ${entry.name} connection lacks ${lacks.join(', ')}`
            : `"${name}"'s ${entry.name} connection needs reconnecting`,
    };
  }

  /** The app entry and the registration a need connects through. */
  function registrationOf(
    name: string,
    need: Need,
    input: ResolveConnectionsInput,
  ): { readonly entry: AppEntry; readonly app: ConnectionAppRecord } | Refused {
    const entry = entries.get(need.app);
    const app = entry && registrationsFor(input.tenantId, need.app, input.projectId)[0];
    if (entry === undefined || app === undefined) {
      return {
        kind: 'refused',
        code: 'connection-app-missing',
        name,
        app: need.app,
        message: `No registration of ${entry?.name ?? need.app} lets this project's runs connect`,
      };
    }
    return { entry, app };
  }

  /** One need: its token, a connect to wait for, or why it can't be met. */
  function resolveOne(name: string, need: Need, input: ResolveConnectionsInput): Resolved {
    const registration = registrationOf(name, need, input);
    if ('kind' in registration) return registration;
    const { entry, app } = registration;
    const owner = ownerFor(name, need, entry, input);
    if (owner.kind === 'refused') return owner;
    const found = liveConnection(input.tenantId, app.appId, owner, input.envName);
    const lacks = need.permissions.filter((p) => !found?.record.permissions.includes(p));
    if (found?.record.state === 'working' && lacks.length === 0) {
      const token = tokenFor(found, name, input.renew?.includes(name) === true);
      if (token !== 'invalid-grant') return { kind: 'ready', connection: token };
    }
    const existing = liveConnection(input.tenantId, app.appId, owner, input.envName);
    if (need.as === 'company' || input.waitMs <= 0) {
      return missingRefusal(name, entry, existing, lacks);
    }
    return {
      kind: 'wait',
      wait: {
        names: [name],
        entry,
        app,
        owner,
        ...(existing !== undefined && { existing }),
        permissions: [...need.permissions],
      },
    };
  }

  /** The connect request a wait is for: the call's own, made once. */
  function waitingFor(wait: Wait, input: ResolveConnectionsInput): WaitingForConnection {
    const name = wait.names[0] as string;
    const waitToken = computeConnectWaitToken({
      runId: input.runId,
      ...(input.stepScope !== undefined && { stepScope: input.stepScope }),
      callId: input.callId,
      name,
    });
    const request =
      [...requests.values()].find(
        (s) => s.record.tenantId === input.tenantId && s.record.waitToken === waitToken,
      )?.record ??
      newRequest({
        tenantId: input.tenantId,
        envName: input.envName,
        app: wait.app,
        entry: wait.entry,
        owner: wait.owner,
        permissions: union(wait.permissions, wait.existing?.record.permissions ?? []),
        ...(wait.existing !== undefined && { reconnects: wait.existing.record.connectionId }),
        run: { runId: input.runId, waitToken, name },
        expiresAtMs: now() + input.waitMs,
        createdBy: `user:${(input.person as { userId: string }).userId}`,
      });
    return {
      name,
      requestId: request.requestId,
      waitToken,
      app: wait.entry.id,
      appName: wait.entry.name,
      says: request.says,
      connectUrl: request.connectUrl,
      expiresAt: request.expiresAt,
      ...(request.reconnects !== undefined && { reconnects: true }),
    };
  }

  async function resolveConnections(
    input: ResolveConnectionsInput,
  ): Promise<ResolveConnectionsOutcome> {
    const ready: Record<string, ToolConnection> = {};
    const waits = new Map<string, Wait>();
    for (const name of Object.keys(input.needs).sort()) {
      const resolved = resolveOne(name, input.needs[name] as Need, input);
      if (resolved.kind === 'refused') return resolved;
      if (resolved.kind === 'ready') {
        ready[name] = resolved.connection;
        continue;
      }
      // One request per connection, for all the call's needs of it.
      const key = `${resolved.wait.app.appId}|${ownerKey(resolved.wait.owner)}`;
      const wait = waits.get(key);
      if (wait === undefined) {
        waits.set(key, resolved.wait);
        continue;
      }
      wait.names.push(name);
      wait.permissions = union(wait.permissions, resolved.wait.permissions);
    }
    if (waits.size === 0) return { kind: 'ready', connections: ready };
    return { kind: 'wait', requests: [...waits.values()].map((w) => waitingFor(w, input)) };
  }

  // ---------------- seeding ----------------

  const seed = {
    app(input: ConnectionAppCreateInput): ConnectionAppRecord {
      const created = createApp(input);
      if (created.kind === 'err') throw new TypeError(created.error.message);
      return created.value;
    },
    connection(input: SeedConnectionInput): ConnectionRecord {
      const entry = entries.get(input.app);
      if (entry === undefined) throw new TypeError(`No app entry "${input.app}"`);
      const app =
        input.appId !== undefined
          ? liveApp(input.tenantId, input.appId)
          : registrationsFor(input.tenantId, input.app, undefined)[0];
      if (app === undefined)
        throw new TypeError(`No registration of ${entry.name}: seed one first`);
      if (liveConnection(input.tenantId, app.appId, input.owner, input.envName) !== undefined) {
        throw new TypeError('That owner already has a connection through the registration');
      }
      const at = iso();
      const stored: StoredConnection = {
        record: {
          connectionId: randomUUID(),
          tenantId: input.tenantId,
          envName: input.envName,
          appId: app.appId,
          app: input.app,
          owner: input.owner,
          account: input.account,
          permissions: [...input.permissions],
          state: input.state ?? 'working',
          ...(input.installationId !== undefined && { installationId: input.installationId }),
          connectedAt: at,
          createdAt: at,
          createdBy: 'seed',
          updatedAt: at,
        },
      };
      if (stored.record.state === 'working') issueToken(stored);
      connections.set(stored.record.connectionId, stored);
      return stored.record;
    },
  };

  return { binding, resolver: { resolveConnections }, seed, calls };
}
