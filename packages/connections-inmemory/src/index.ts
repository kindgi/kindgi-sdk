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
import {
  type ConnectWaitResult,
  computeConnectWaitToken,
  connectionSetRefusal,
} from '@kindgi/agents';
import { comparableName, fitName } from '@kindgi/api';
import type {
  ConnectFinishInput,
  ConnectFinishMain,
  ConnectFinishOutcome,
  ConnectRequestCreateInput,
  ConnectRequestInstallation,
  ConnectRequestRecord,
  ConnectionAppCreateInput,
  ConnectionAppRecord,
  ConnectionAppUpdateInput,
  ConnectionBinding,
  ConnectionChoiceListInput,
  ConnectionChoiceNeedRecord,
  ConnectionChoiceRecord,
  ConnectionChoiceSetInput,
  ConnectionChoiceTarget,
  ConnectionError,
  ConnectionErrorCode,
  ConnectionListInput,
  ConnectionOwner,
  ConnectionPage,
  ConnectionRecord,
  ConnectionRemovedReason,
  ConnectionSetRefusal,
  ConnectionState,
  ConnectionWithdrawn,
} from '@kindgi/api';
import type { PrincipalRef } from '@kindgi/authz';
import { type AppEntry, SIGN_IN_TENANT_PATTERN } from '@kindgi/connections';
import {
  type ConnectionAccount,
  type ConnectionAccountChoices,
  type ConnectionAccountChoicesInput,
  type ConnectionNeed,
  type ConnectionPick,
  ConnectionRenewError,
  type ConnectionResolver,
  type ConnectionRunMailbox,
  type ConnectionTarget,
  type ResolveConnectionsInput,
  type ResolveConnectionsOutcome,
  type ToolConnection,
  type ToolManifest,
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
/**
 * A connection without a refresh token needs reconnecting this long before
 * its access token ends: a fixed minute, so a read can tell from
 * `accessEndsAt` alone.
 */
const ACCESS_END_MARGIN_MS = 60_000;
const HOUR_MS = 60 * 60_000;
/** A connection's label, in characters, as a server's. */
const MAX_LABEL_LENGTH = 100;
/** The states of a connection a choice may name: live, never `removing` or `removed`. */
const LIVE: ReadonlySet<ConnectionState> = new Set(['working', 'needs-reconnecting']);
/** How many connections a set holds, as a server's. */
const SET_SIZE = { min: 2, max: 10 } as const;
const COMPANY: ConnectionOwner = { kind: 'company' };

/** Why a tool keeps one connection, by `connectionSetRefusal`'s answer. */
const SET_REFUSED: Readonly<Record<ConnectionSetRefusal, (tool: string) => string>> = {
  changes: (tool) => `${tool} changes things, so it keeps one connection.`,
  'sensitive-data-egress': (tool) =>
    `${tool} may send what it reads elsewhere, so it keeps one connection.`,
  'accounts-input': (tool) => `${tool} has its own accounts input, so it can't take a set.`,
};

/** What the fake app answers a code with. */
export interface FakeAppExchange {
  /** Whose account it is. A GitHub App's is the installation's, so this is ignored there. */
  readonly account: ConnectionAccount;
  /** The permissions granted. Absent: every one asked. */
  readonly granted?: readonly string[];
  /**
   * Whether it gave a refresh token. Default `true`. Without one, a finish
   * keeps one the connection had before; else an entry whose
   * `signIn.refreshToken` is `'optional'` makes a connection that works
   * until one minute before its token ends (`accessEndsAt`), and any other
   * refuses it (`connection-app-refused`). A GitHub App's tokens come from
   * its key, so this is ignored there.
   */
  readonly refreshToken?: boolean;
  /**
   * Whether its token answer said when the access token ends
   * (`expires_in`). Default `true`. Read only where it gave no refresh
   * token: a finish without either is refused (`connection-app-refused`),
   * since the connection couldn't tell when it ends.
   */
  readonly expiresIn?: boolean;
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
  /**
   * Whether an agent or a flow is one of a project's, for a choice
   * (`setChoice`) and its needs (`choiceNeeds`). Without it none is: each
   * answers `agent-not-found` or `flow-not-found`.
   */
  readonly inProject?: (input: {
    readonly tenantId: TenantId;
    readonly projectId: ProjectId;
    readonly kind: 'agent' | 'flow';
    readonly id: string;
  }) => boolean | Promise<boolean>;
  /**
   * An agent's or a flow's tools, at the versions it resolves to now: what a
   * tool's choice (`setChoice`), `choiceNeeds`, a call's set and
   * `accountChoices` read. Without it, a target has no tools.
   */
  readonly toolsOf?: (input: {
    readonly tenantId: TenantId;
    readonly projectId: ProjectId;
    readonly kind: 'agent' | 'flow';
    readonly id: string;
  }) => TargetTools | Promise<TargetTools>;
}

/** A tool as its agent or flow resolves it now: its needs, and whether it may take a set. */
export type TargetTool = Pick<ToolManifest, 'id' | 'mutating' | 'effects' | 'input' | 'needsSpec'>;

/** An agent's or a flow's tools; `unread` names those whose version couldn't be read. */
export interface TargetTools {
  readonly tools: readonly TargetTool[];
  readonly unread?: readonly string[];
}

/** A connection put in place without a connect. It's never made main: `update` does that. */
export interface SeedConnectionInput {
  readonly tenantId: TenantId;
  readonly envName: EnvName;
  readonly app: string;
  /** Which registration, when the workspace has more than one for the app. */
  readonly appId?: string;
  readonly owner: ConnectionOwner;
  readonly account: ConnectionAccount;
  /** Absent: none, as on a connection made before connections had names. */
  readonly label?: string;
  readonly permissions: readonly string[];
  readonly state?: ConnectionState;
  readonly installationId?: string;
  /**
   * `false`: the app gave no refresh token, so it works until one minute
   * before its token ends (`accessEndsAt`). Only for an entry whose
   * `signIn.refreshToken` is `'optional'`. Default `true`.
   */
  readonly refreshToken?: boolean;
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
  /** It has no refresh token: its token is all it has, until it ends. */
  noRefresh?: true | undefined;
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
  | { readonly kind: 'ready'; readonly connection: ToolConnection; readonly pick: ConnectionPick }
  | { readonly kind: 'wait'; readonly wait: Wait }
  | Refused;

/** How the resolver's steps 1 to 4 picked a need's connection. */
interface Picked {
  readonly by: 'mailbox' | 'choice' | 'named';
  readonly connectionId: string;
  readonly choiceId?: string;
  /** With a set: how many connections it holds. */
  readonly setSize?: number;
}

/** What a choice's version counts in: project, env, target, app, tool and need, and owner. */
interface ChoiceKey {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly envName: EnvName;
  readonly target: ConnectionChoiceTarget;
  readonly app: string;
  readonly aim: ToolNeed | undefined;
  readonly owner: ConnectionOwner;
}

/** A tool's need a choice is for. */
interface ToolNeed {
  readonly toolId: string;
  readonly need: string;
}

/** What a choice is for, a tool's need or none, and its set, if it has one. */
interface ChoiceAim {
  readonly aim: ToolNeed | undefined;
  readonly set: readonly string[] | undefined;
}

/** A need's set a call may name from, as `accountChoices` answers it. */
type AccountSet = ConnectionAccountChoices[string][string];

/** Why a connection picked for a need can't serve it, and whether reconnecting would. */
interface Unserved {
  readonly why: string;
  readonly reconnect: boolean;
  readonly lacks?: readonly string[];
}

/** Who a code signed in as, and through which GitHub App installation. */
interface SignedIn {
  readonly account: ConnectionAccount;
  readonly installationId: string | undefined;
}

function ok<T>(value: T): Outcome<T> {
  return { kind: 'ok', value };
}

/**
 * Why a tool's choice can't be for its need, else nothing: the need is the
 * other owner's (`as`), so the choice would never be read.
 */
function otherOwnersNeed(
  input: ConnectionChoiceSetInput,
  { toolId, need }: ToolNeed,
  as: ConnectionNeed['as'] | undefined,
  appName: string,
): Outcome<never> | undefined {
  if (as === 'person' && input.person === undefined) {
    return refuse(
      'bad-input',
      `${toolId}'s ${need} is each person's own ${appName} connection: a person chooses their own (person, or --mine).`,
      { field: 'person' },
    );
  }
  if (as === 'company' && input.person !== undefined) {
    return refuse(
      'bad-input',
      `${toolId}'s ${need} is the company's ${appName} connection: a project admin chooses it for the project, not each person.`,
      { field: 'person' },
    );
  }
  return undefined;
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

/** The agent or the flow alone, from an input that names one. */
function targetOf(input: ConnectionChoiceTarget): ConnectionChoiceTarget {
  return input.agentId !== undefined ? { agentId: input.agentId } : { flowId: input.flowId };
}

/** A call's agent or flow, as a choice names it. */
function choiceTarget(target: ConnectionTarget): ConnectionChoiceTarget {
  return 'agentId' in target ? { agentId: target.agentId } : { flowId: target.flowId };
}

function sameTarget(a: ConnectionChoiceTarget, b: ConnectionChoiceTarget): boolean {
  return a.agentId !== undefined ? a.agentId === b.agentId : a.flowId === b.flowId;
}

/** Whose a choice is: the company's, or the person's it names. */
function choiceOwner(of: { readonly person?: { readonly userId: string } }): ConnectionOwner {
  return of.person === undefined ? COMPANY : { kind: 'member', userId: of.person.userId };
}

/** Whether a choice has the key its version counts in. */
function keyed(c: ConnectionChoiceRecord, key: ChoiceKey): boolean {
  return (
    c.tenantId === key.tenantId &&
    c.projectId === key.projectId &&
    c.envName === key.envName &&
    c.app === key.app &&
    c.toolId === key.aim?.toolId &&
    c.need === key.aim?.need &&
    ownerKey(choiceOwner(c)) === ownerKey(key.owner) &&
    sameTarget(c, key.target)
  );
}

/** Whether a choice is one of those asked for: absent, the company's only. */
function ownedAsAsked(
  c: ConnectionChoiceRecord,
  owners: ConnectionChoiceListInput['owners'],
): boolean {
  if (c.person === undefined) return owners?.company ?? true;
  const person = owners?.person;
  return person === 'every' || person?.userId === c.person.userId;
}

/** Whether two sets hold the same connections; no set is the same as no set alone. */
function sameSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** The connection a need's mailbox binds it to: the run's mailbox of its app and owner. */
function mailboxOf(
  need: ConnectionNeed,
  mailbox: ConnectionRunMailbox | undefined,
): string | undefined {
  return mailbox?.as === need.as && mailbox.app === need.app ? mailbox.connectionId : undefined;
}

/** A tool's needs of connections, by their names, sorted. */
function needsOf(tool: TargetTool | undefined): [string, ConnectionNeed][] {
  const needs: Readonly<Record<string, ConnectionNeed>> = tool?.needsSpec?.connections ?? {};
  return Object.entries(needs).sort(([a], [b]) => a.localeCompare(b));
}

/** A tool's needs as a needs read answers them: only those of `app`, when it's given. */
function needRecordsOf(tool: TargetTool, app: string | undefined): ConnectionChoiceNeedRecord[] {
  const refusal = connectionSetRefusal(tool);
  const records: ConnectionChoiceNeedRecord[] = [];
  for (const [need, spec] of needsOf(tool)) {
    if (app !== undefined && spec.app !== app) continue;
    records.push({
      toolId: tool.id,
      need,
      app: spec.app,
      as: spec.as,
      set: refusal === undefined ? { allowed: true } : { allowed: false, reason: refusal },
    });
  }
  return records;
}

/** The record without `main`: a connection that isn't, or is no more, its person's main one. */
function withoutMain(record: ConnectionRecord): ConnectionRecord {
  const { main: _main, ...rest } = record;
  return rest;
}

function oldestFirst(a: ConnectionChoiceRecord, b: ConnectionChoiceRecord): number {
  return a.createdAt.localeCompare(b.createdAt) || a.choiceId.localeCompare(b.choiceId);
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
  const choices = new Map<string, ConnectionChoiceRecord>();
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
    const overlap = overlapping(entry, input.tenantId, input.projects, undefined);
    if (overlap !== undefined) return overlap;
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

  /** The agent or the flow, as `inProject` and `toolsOf` ask about it. */
  function targetAsked(
    input: { readonly tenantId: TenantId; readonly projectId: ProjectId },
    target: ConnectionChoiceTarget,
  ) {
    const kind: 'agent' | 'flow' = target.agentId !== undefined ? 'agent' : 'flow';
    const id = (target.agentId ?? target.flowId) as string;
    return { tenantId: input.tenantId, projectId: input.projectId, kind, id };
  }

  /** The refusal when the agent or the flow isn't one of the project's. */
  async function outsideProject(
    input: { readonly tenantId: TenantId; readonly projectId: ProjectId },
    target: ConnectionChoiceTarget,
  ): Promise<Outcome<never> | undefined> {
    const asked = targetAsked(input, target);
    if (await (options.inProject?.(asked) ?? false)) return undefined;
    const { kind, id } = asked;
    return refuse(`${kind}-not-found`, `No ${kind} "${id}" in the project`, {
      field: `${kind}Id`,
    });
  }

  /** The target's tools at the versions it resolves to now: none without `toolsOf`. */
  async function targetTools(
    input: { readonly tenantId: TenantId; readonly projectId: ProjectId },
    target: ConnectionChoiceTarget,
  ): Promise<TargetTools> {
    return (await options.toolsOf?.(targetAsked(input, target))) ?? { tools: [] };
  }

  /**
   * The connection a choice names, when it's a candidate of the choice's
   * owner (and of `app`, for a set's member). A person's live connection in
   * the env, in the company's choice, says why it can't be; any other that
   * isn't a candidate is the same `connection-not-found` as an id that
   * isn't there, so an id tells nothing more.
   */
  function choosable(
    input: ConnectionChoiceSetInput,
    connectionId: string,
    field: 'connectionId' | 'connectionIds',
    app?: string,
  ): Outcome<ConnectionRecord> {
    const stored = connections.get(connectionId);
    const connection =
      stored !== undefined && stored.record.tenantId === input.tenantId
        ? current(stored)
        : undefined;
    if (
      input.person === undefined &&
      connection?.owner.kind === 'member' &&
      LIVE.has(connection.state) &&
      connection.envName === input.envName
    ) {
      return refuse(
        'bad-input',
        "This is a person's connection: a person chooses their own (person, or --mine).",
        { field },
      );
    }
    if (
      connection === undefined ||
      (app !== undefined && connection.app !== app) ||
      !candidate(connection, input.projectId, input.envName, choiceOwner(input))
    ) {
      return refuse('connection-not-found', 'No such connection', { field });
    }
    return ok(connection);
  }

  /**
   * Whether a choice in the project may name the connection: the owner's
   * (the company's, else that person's own), live (working, or needing a
   * reconnect), in the env, on a live registration that allows the project.
   */
  function candidate(
    c: ConnectionRecord,
    projectId: ProjectId,
    envName: EnvName,
    owner: ConnectionOwner = COMPANY,
  ): boolean {
    if (ownerKey(c.owner) !== ownerKey(owner) || !LIVE.has(c.state) || c.envName !== envName) {
      return false;
    }
    const app = liveApp(c.tenantId, c.appId);
    return app !== undefined && allows(app, projectId);
  }

  /**
   * The tool's need a choice is for (`toolId`), at the version the target
   * resolves to now: one of the app the tool has, named, or its only one,
   * whose owner (`as`) is the choice's, since a choice of the other owner
   * is never read. None for the target's own choice (`withoutTool`).
   */
  async function toolNeedOf(
    input: ConnectionChoiceSetInput,
    target: ConnectionChoiceTarget,
    app: string,
  ): Promise<Outcome<(ToolNeed & { readonly tool: TargetTool }) | undefined>> {
    if (input.toolId === undefined) return withoutTool(input, target, app);
    const toolId = input.toolId;
    const appName = entries.get(app)?.name ?? app;
    const tool = (await targetTools(input, target)).tools.find((t) => t.id === toolId);
    const specs = new Map(needsOf(tool).filter(([, need]) => need.app === app));
    const needs = [...specs.keys()];
    if (tool === undefined || needs.length === 0) {
      const { kind } = targetAsked(input, target);
      return refuse('bad-input', `The ${kind} has no tool ${toolId} that uses ${appName}.`, {
        field: 'toolId',
      });
    }
    const need = input.need ?? (needs.length === 1 ? needs[0] : undefined);
    if (need === undefined) {
      return refuse(
        'bad-input',
        `${toolId} uses ${appName} twice: name the need (${needs.join(', ')}).`,
        { field: 'need' },
      );
    }
    if (!needs.includes(need)) {
      return refuse('bad-input', `${toolId} has no need ${need} of ${appName}.`, {
        field: 'need',
      });
    }
    const owners = otherOwnersNeed(input, { toolId, need }, specs.get(need)?.as, appName);
    if (owners !== undefined) return owners;
    return ok({ toolId, need, tool });
  }

  /**
   * The target's own choice (no `toolId`): no `need` and no set, and, when
   * the target's tools use the app now, one of their needs of it the choice
   * owner's, since a choice of the other owner is never read.
   */
  async function withoutTool(
    input: ConnectionChoiceSetInput,
    target: ConnectionChoiceTarget,
    app: string,
  ): Promise<Outcome<undefined>> {
    if (input.need !== undefined) {
      return refuse('bad-input', "`need` is a tool's: name the tool (`toolId`)", {
        field: 'need',
      });
    }
    if (input.connectionIds !== undefined) {
      return refuse('bad-input', 'A set of connections is for one tool: name it.', {
        field: 'connectionIds',
      });
    }
    // A target that doesn't use the app now may be chosen for ahead.
    const owners = (await targetTools(input, target)).tools.flatMap((t) =>
      needsOf(t)
        .filter(([, need]) => need.app === app)
        .map(([, need]) => need.as),
    );
    const person = input.person !== undefined;
    if (owners.length === 0 || owners.some((as) => (as === 'person') === person)) {
      return ok(undefined);
    }
    const { kind } = targetAsked(input, target);
    const appName = entries.get(app)?.name ?? app;
    return refuse(
      'bad-input',
      person
        ? `The ${kind} uses ${appName} only as the company's connection: a project admin chooses it for the project, not each person.`
        : `The ${kind} uses ${appName} only as each person's own connection: a person chooses their own (person, or --mine).`,
      { field: 'person' },
    );
  }

  /**
   * A choice's set (`connectionIds`): 2 to 10 different candidates of the
   * default's app, every one named, the default among them, for a tool
   * that may take one (`connectionSetRefusal`).
   */
  function setOf(
    input: ConnectionChoiceSetInput,
    connection: ConnectionRecord,
    aim: { readonly toolId: string; readonly tool: TargetTool } | undefined,
  ): Outcome<readonly string[] | undefined> {
    const ids = input.connectionIds;
    if (ids === undefined) return ok(undefined);
    const at = { field: 'connectionIds' };
    if (aim === undefined) {
      return refuse('bad-input', 'A set of connections is for one tool: name it.', at);
    }
    if (ids.length < SET_SIZE.min || ids.length > SET_SIZE.max || new Set(ids).size < ids.length) {
      return refuse(
        'bad-input',
        `A set holds ${SET_SIZE.min} to ${SET_SIZE.max} different connections.`,
        at,
      );
    }
    if (!ids.includes(connection.connectionId)) {
      return refuse('bad-input', 'The default must be one of the set.', at);
    }
    const refusal = connectionSetRefusal(aim.tool);
    if (refusal !== undefined) return refuse('bad-input', SET_REFUSED[refusal](aim.toolId), at);
    const members = membersOf(input, ids, connection.app);
    if (members.kind !== 'ok') return members;
    return ok([...ids]);
  }

  /**
   * A set's members, in the order named: each a candidate of `app`
   * (`choosable`), and every one named, since the agent picks them by name.
   */
  function membersOf(
    input: ConnectionChoiceSetInput,
    ids: readonly string[],
    app: string,
  ): Outcome<readonly ConnectionRecord[]> {
    const members: ConnectionRecord[] = [];
    for (const id of ids) {
      const member = choosable(input, id, 'connectionIds', app);
      if (member.kind !== 'ok') return member;
      members.push(member.value);
    }
    const unnamed = members.find((m) => m.label === undefined);
    if (unnamed !== undefined) {
      return refuse(
        'bad-input',
        `Name ${unnamed.account.label} first: the agent picks a set's connections by name.`,
        { field: 'connectionIds' },
      );
    }
    return ok(members);
  }

  /** The tool's need a choice is for, if any (`toolNeedOf`), and its set (`setOf`). */
  async function aimAndSet(
    input: ConnectionChoiceSetInput,
    target: ConnectionChoiceTarget,
    connection: ConnectionRecord,
  ): Promise<Outcome<ChoiceAim>> {
    const aimed = await toolNeedOf(input, target, connection.app);
    if (aimed.kind !== 'ok') return aimed;
    const set = setOf(input, connection, aimed.value);
    if (set.kind !== 'ok') return set;
    const aim = aimed.value && { toolId: aimed.value.toolId, need: aimed.value.need };
    return ok({ aim, set: set.value });
  }

  /**
   * A project uses one registration of an app, so a run's connect is never a
   * guess: another live registration of the app may not serve a project
   * this one would (every project, without `projects`).
   */
  function overlapping(
    entry: AppEntry,
    tenantId: TenantId,
    projects: readonly ProjectId[] | undefined,
    exceptId: string | undefined,
  ): Outcome<never> | undefined {
    for (const other of apps.values()) {
      if (
        other.tenantId !== tenantId ||
        other.app !== entry.id ||
        other.removedAt !== undefined ||
        other.appId === exceptId
      ) {
        continue;
      }
      if (other.projects === undefined || projects === undefined) {
        return refuse(
          'connection-app-invalid',
          everyProjectOverlap(
            entry,
            other.appId,
            other.projects === undefined,
            projects === undefined,
          ),
          { field: 'projects' },
        );
      }
      const shared = projects.find((p) => other.projects?.includes(p));
      if (shared !== undefined) {
        return refuse(
          'connection-app-invalid',
          `Registration ${other.appId} of ${entry.name} already serves project ${shared}; a project uses one registration of an app`,
          { field: 'projects' },
        );
      }
    }
    return undefined;
  }

  /** Why a registration that serves every project, or would, overlaps another: what to change first. */
  function everyProjectOverlap(
    entry: AppEntry,
    id: string,
    liveEvery: boolean,
    thisEvery: boolean,
  ): string {
    const one = `Registration ${id} of ${entry.name}`;
    if (liveEvery && thisEvery) {
      return `${one} already serves every project, as this one would; a project uses one registration of an app, so remove ${id} first, or give each a list of projects that don't overlap`;
    }
    if (liveEvery) {
      return `${one} already serves every project; a project uses one registration of an app, so give ${id} a list of projects this one doesn't name, or remove it, first`;
    }
    return `${one} already serves its own list of projects, and this one would serve every project; a project uses one registration of an app, so give this one a list of projects ${id} doesn't serve`;
  }

  /** The field naming a change of the client the registration's connections were granted to, if any. */
  function changedClientField(
    app: ConnectionAppRecord,
    input: ConnectionAppUpdateInput,
  ): string | undefined {
    if (app.oauth2 !== undefined && input.oauth2 !== undefined) {
      return changedOAuth2Field(app.app, app.oauth2, input.oauth2);
    }
    if (app.githubApp === undefined || input.githubApp === undefined) return undefined;
    if (app.githubApp.appNumber !== input.githubApp.appNumber) return 'githubApp.appNumber';
    if (app.githubApp.clientId !== input.githubApp.clientId) return 'githubApp.clientId';
    return undefined;
  }

  /**
   * The directory counts as the client: the connections' refresh tokens
   * belong to it. It's compared as the sign-in uses it, the entry's default
   * standing in for none, so leaving `tenant` out can't move it quietly.
   */
  function changedOAuth2Field(
    app: string,
    was: NonNullable<ConnectionAppRecord['oauth2']>,
    now: NonNullable<ConnectionAppUpdateInput['oauth2']>,
  ): string | undefined {
    if (was.clientId !== now.clientId) return 'oauth2.clientId';
    const entry = entries.get(app);
    const fallback = entry?.signIn.kind === 'oauth2' ? entry.signIn.tenant?.default : undefined;
    return (was.tenant ?? fallback) === (now.tenant ?? fallback) ? undefined : 'oauth2.tenant';
  }

  /** A change of the client while connections granted to it live: they're disconnected first. */
  function clientInUse(
    app: ConnectionAppRecord,
    input: ConnectionAppUpdateInput,
  ): Outcome<never> | undefined {
    const field = changedClientField(app, input);
    const granted = field === undefined ? 0 : connectionsOf(app).length;
    if (field === undefined || granted === 0) return undefined;
    return refuse(
      'connection-app-invalid',
      `${granted} connection(s) were granted to this registration's current ${grantedTo(field)}: disconnect them first, then change it and connect again`,
      { field },
    );
  }

  /** What the connections were granted to, named by the changed field, for the refusal. */
  function grantedTo(field: string): string {
    if (field === 'githubApp.appNumber') return 'GitHub App';
    return field === 'oauth2.tenant' ? 'directory' : 'client';
  }

  /** The registration's connections that aren't removed. */
  function connectionsOf(app: ConnectionAppRecord): StoredConnection[] {
    return [...connections.values()].filter(
      (c) => c.record.appId === app.appId && c.record.state !== 'removed',
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

  /** The owner's live connections through the registration in the env, oldest first. */
  function ownerConnections(
    of: Pick<ConnectionRecord, 'tenantId' | 'appId' | 'envName'>,
    owner: ConnectionOwner,
  ): StoredConnection[] {
    const key = ownerKey(owner);
    return [...connections.values()].filter(
      ({ record: c }) =>
        c.tenantId === of.tenantId &&
        c.appId === of.appId &&
        c.envName === of.envName &&
        ownerKey(c.owner) === key &&
        c.state !== 'removed',
    );
  }

  /** The live connection `connectionId`, if it's the owner's through the registration in the env. */
  function ownConnection(
    of: Pick<ConnectRequestRecord, 'tenantId' | 'appId' | 'owner' | 'envName'>,
    connectionId: string,
  ): StoredConnection | undefined {
    const stored = connections.get(connectionId);
    const c = stored?.record;
    return c !== undefined &&
      c.tenantId === of.tenantId &&
      c.appId === of.appId &&
      c.envName === of.envName &&
      ownerKey(c.owner) === ownerKey(of.owner) &&
      c.state !== 'removed'
      ? stored
      : undefined;
  }

  /**
   * The owner's live connection of the account through the registration in
   * the env: the company and a person each keep one per account.
   */
  function accountConnection(
    of: Pick<ConnectRequestRecord, 'tenantId' | 'appId' | 'envName'>,
    owner: ConnectionOwner,
    accountId: string,
  ): StoredConnection | undefined {
    return ownerConnections(of, owner).find((s) => s.record.account.id === accountId);
  }

  /**
   * Makes a person's connection their main one through its registration in
   * its env, in one step: the one that was is main no more. The main one
   * already is left as it is.
   */
  function makeMain(stored: StoredConnection): void {
    if (stored.record.main === true) return;
    const at = iso();
    for (const other of ownerConnections(stored.record, stored.record.owner)) {
      if (other.record.main !== true) continue;
      other.record = { ...withoutMain(other.record), updatedAt: at };
    }
    stored.record = { ...stored.record, main: true, updatedAt: at };
  }

  /**
   * What a person's new connection does to their main one through the
   * registration in the env, before it's stored: the one they had becomes
   * it, unless one of theirs already is; with several and none main, none
   * is set. Nothing for their first, or for the company's.
   */
  function mainOnConnect(request: ConnectRequestRecord): ConnectFinishMain | undefined {
    if (request.owner.kind !== 'member') return undefined;
    const had = ownerConnections(request, request.owner);
    const main = had.find((s) => s.record.main === true);
    if (main !== undefined) return { state: 'kept', connectionId: main.record.connectionId };
    const [only, ...more] = had;
    if (only === undefined) return undefined;
    if (more.length > 0) return { state: 'missing' };
    makeMain(only);
    return { state: 'set', connectionId: only.record.connectionId };
  }

  /**
   * Another live connection of the app, owner and env named `label`, by
   * `comparableName` (names that look the same);
   * `except` is the connection being named.
   */
  function labelTaken(
    of: Pick<ConnectionRecord, 'tenantId' | 'app' | 'owner' | 'envName'>,
    label: string,
    except?: string,
  ): boolean {
    const key = ownerKey(of.owner);
    const wanted = comparableName(label);
    for (const { record: c } of connections.values()) {
      if (
        c.connectionId !== except &&
        c.tenantId === of.tenantId &&
        c.app === of.app &&
        c.envName === of.envName &&
        ownerKey(c.owner) === key &&
        c.state !== 'removed' &&
        c.label !== undefined &&
        comparableName(c.label) === wanted
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * A new connection's label: the request's, else the account's made to fit
   * in 100 characters (`fitName`). When another has it, the first free
   * `<label> 2`, `<label> 3`, and so on, the label cut to fit the number, and
   * `taken` is the one it was to get: a finish isn't failed for it.
   */
  function newLabel(
    request: ConnectRequestRecord,
    account: ConnectionAccount,
  ): { readonly label?: string; readonly taken?: string } {
    const label = request.label ?? fitName(account.label, MAX_LABEL_LENGTH);
    if (label.length === 0) return {};
    if (!labelTaken(request, label)) return { label };
    for (let n = 2; ; n += 1) {
      const suffix = ` ${n}`;
      // A label of one character longer than the cut leaves only the number.
      const next = `${fitName(label, MAX_LABEL_LENGTH - suffix.length)}${suffix}`.trimStart();
      if (!labelTaken(request, next)) return { label: next, taken: label };
    }
  }

  function issueToken(stored: StoredConnection): void {
    stored.token = { n: (stored.token?.n ?? 0) + 1, expiresAtMs: now() + ttlMs };
  }

  /**
   * A token for a connection a finish or a seed stores: one that renews
   * has no `accessEndsAt`; one without a refresh token ends with the token.
   */
  function issueFirstToken(stored: StoredConnection, renews: boolean): void {
    issueToken(stored);
    const { accessEndsAt: _ends, ...rest } = stored.record;
    if (renews) {
      stored.noRefresh = undefined;
      stored.record = rest;
      return;
    }
    stored.noRefresh = true;
    const token = stored.token as NonNullable<StoredConnection['token']>;
    stored.record = { ...rest, accessEndsAt: iso(token.expiresAtMs) };
  }

  /**
   * Whether the connection a finish stores renews: the app gave a refresh
   * token, or the connection it lands on kept one, or the app has none to
   * give (a GitHub App). Else it ends with its token where the entry's
   * `signIn.refreshToken` is `'optional'`, and is refused otherwise.
   */
  function renewal(
    request: ConnectRequestRecord,
    live: StoredConnection | undefined,
    gaveRefresh: boolean,
  ): 'renews' | 'ends' | 'refused' {
    const signIn = entries.get(request.app)?.signIn;
    if (signIn?.kind !== 'oauth2' || gaveRefresh) return 'renews';
    if (live !== undefined && live.noRefresh !== true) return 'renews';
    return signIn.refreshToken === 'optional' ? 'ends' : 'refused';
  }

  /**
   * Why a finish can't keep the connection, if it can't: no refresh token
   * where the entry requires one, or none and no word on when the access
   * token ends.
   */
  function unkeepable(
    request: ConnectRequestRecord,
    renews: 'renews' | 'ends' | 'refused',
    saidEnd: boolean,
  ): string | undefined {
    const name = entries.get(request.app)?.name ?? request.app;
    if (renews === 'refused') {
      return `${name} gave no refresh token, so the connection couldn't keep working: start again`;
    }
    if (renews === 'ends' && !saidEnd) {
      return `${name} gave no refresh token and didn't say when its access token ends (expires_in), so the connection couldn't tell when to stop: start again`;
    }
    return undefined;
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

  /** A removed main one is main no more, and no other is made main in its place. */
  function remove(
    stored: StoredConnection,
    by: string,
    reason: ConnectionRemovedReason,
    withdrawn: ConnectionWithdrawn,
  ): ConnectionRecord {
    const at = iso();
    stored.record = {
      ...withoutMain(stored.record),
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
    readonly label?: string;
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
      ...(input.label !== undefined && { label: input.label }),
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

  /**
   * The connection a connect reconnects: the one `reconnects` names, which
   * must be the owner's through the registration in the env. The owner's of
   * an account, the company's or a person's, is known only at the finish.
   */
  function reconnectedBy(
    input: ConnectRequestCreateInput,
    appId: string,
  ): Outcome<StoredConnection | undefined> {
    if (input.reconnects === undefined) return ok(undefined);
    const named = ownConnection({ ...input, appId }, input.reconnects);
    // Another owner's, registration's or env's, a removed one or none: one answer.
    return named !== undefined
      ? ok(named)
      : refuse('connection-not-found', 'No such connection to reconnect', { field: 'reconnects' });
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
    const reconnects = reconnectedBy(input, app.value.appId);
    if (reconnects.kind === 'err') return reconnects;
    const existing = reconnects.value;
    // A reconnect keeps the connection's label, so the one asked isn't checked.
    if (existing === undefined && input.label !== undefined && labelTaken(input, input.label)) {
      return refuse('connection-label-taken', `Another connection is named "${input.label}"`, {
        field: 'label',
      });
    }
    return ok(
      newRequest({
        tenantId: input.tenantId,
        envName: input.envName,
        app: app.value,
        entry,
        owner: input.owner,
        permissions: union(input.permissions, existing?.record.permissions ?? []),
        ...(existing !== undefined && { reconnects: existing.record.connectionId }),
        ...(input.label !== undefined && { label: input.label }),
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
    const scopes = new Set([
      ...(signIn.scopes ?? []),
      ...(entry.account.kind === 'github-installation' ? [] : entry.account.scopes),
      ...request.permissions.map((p) => entry.permissions[p]?.grants ?? p),
    ]);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', app.oauth2?.clientId ?? '');
    url.searchParams.set('redirect_uri', app.redirectUrl);
    url.searchParams.set('scope', [...scopes].join(' '));
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

  /**
   * The connection a finish makes or reconnects, with what was granted. A
   * reconnect keeps its label; a new one's may have been taken. A person's
   * new one keeps their main one (`mainOnConnect`).
   */
  function storeConnection(
    request: ConnectRequestRecord,
    live: StoredConnection | undefined,
    made: SignedIn & { readonly granted: readonly string[] },
  ): {
    readonly stored: StoredConnection;
    readonly labelTaken?: string;
    readonly main?: ConnectFinishMain;
  } {
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
      return { stored: live };
    }
    const { label, taken } = newLabel(request, made.account);
    const main = mainOnConnect(request);
    const connection: StoredConnection = {
      record: {
        connectionId: randomUUID(),
        tenantId: request.tenantId,
        envName: request.envName,
        appId: request.appId,
        app: request.app,
        owner: request.owner,
        account: made.account,
        ...(label !== undefined && { label }),
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
    return {
      stored: connection,
      ...(taken !== undefined && { labelTaken: taken }),
      ...(main !== undefined && { main }),
    };
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
        reconnected: true,
      });
    }
    const missing = union(request.permissions, held).filter((p) => !kept.includes(p));
    return ok({
      kind: 'declined',
      request: await settle(stored, { state: 'declined', missing }, { kind: 'declined', missing }),
    });
  }

  /**
   * The live connection a finish lands on: the one it reconnects, while
   * it's still live; else the owner's of the account signed in to, the
   * company's or a person's, so one account never has two.
   */
  function landsOn(
    request: ConnectRequestRecord,
    account: ConnectionAccount,
  ): StoredConnection | undefined {
    const named =
      request.reconnects !== undefined ? ownConnection(request, request.reconnects) : undefined;
    return named ?? accountConnection(request, request.owner, account.id);
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
    gave: { readonly refreshToken: boolean; readonly expiresIn: boolean },
  ): Promise<Outcome<ConnectFinishOutcome>> {
    const request = stored.record;
    // Nothing is awaited from here to the store, so two finishes of one
    // account can't both make a connection.
    const live = landsOn(request, signedIn.account);
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
    const renews = renewal(request, live, gave.refreshToken);
    const refused = unkeepable(request, renews, gave.expiresIn);
    if (refused !== undefined) {
      await settle(stored, { state: 'failed', failure: 'app-refused' });
      return refuse('connection-app-refused', refused);
    }
    const {
      stored: connection,
      labelTaken,
      main,
    } = storeConnection(request, live, {
      ...signedIn,
      granted: kept,
    });
    issueFirstToken(connection, renews === 'renews');
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
      reconnected: live !== undefined,
      ...(labelTaken !== undefined && { labelTaken }),
      ...(main !== undefined && { main }),
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
    return connect(stored, exchanged.granted, signedIn.value, {
      refreshToken: exchanged.refreshToken !== false,
      expiresIn: exchanged.expiresIn !== false,
    });
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
      const entry = entries.get(app.app) as AppEntry;
      const checked = checkSignIn(entry, input, 'update');
      if (checked.kind === 'err') return checked;
      const inUse = clientInUse(app, input);
      if (inUse !== undefined) return inUse;
      const projects = input.projects === undefined ? app.projects : (input.projects ?? undefined);
      const overlap = overlapping(entry, app.tenantId, projects, app.appId);
      if (overlap !== undefined) return overlap;
      const { projects: _projects, ...rest } = app;
      const updated: ConnectionAppRecord = {
        ...rest,
        ...(input.label !== undefined && { label: input.label }),
        ...(input.oauth2 !== undefined && { oauth2: input.oauth2 }),
        ...(input.githubApp !== undefined && { githubApp: input.githubApp }),
        ...(projects !== undefined && { projects: [...projects] }),
        updatedAt: iso(),
      };
      apps.set(app.appId, updated);
      return ok(updated);
    },

    async removeApp(input) {
      const app = liveApp(input.tenantId, input.appId);
      if (app === undefined) return refuse('connection-app-not-found', 'No such registration');
      const live = connectionsOf(app);
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
        .map(current)
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
        ? current(stored)
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

    async update(input) {
      const stored = connections.get(input.connectionId);
      if (
        stored === undefined ||
        stored.record.tenantId !== input.tenantId ||
        stored.record.state === 'removed'
      ) {
        return refuse('connection-not-found', 'No such connection');
      }
      const { label } = input;
      if (input.main === true && stored.record.owner.kind === 'company') {
        return refuse(
          'bad-input',
          "The company has no main connection: its agents use the company's through their choices.",
          { field: 'main' },
        );
      }
      if (label !== undefined && labelTaken(stored.record, label, input.connectionId)) {
        return refuse('connection-label-taken', `Another connection is named "${label}"`, {
          field: 'label',
        });
      }
      if (label !== undefined) stored.record = { ...stored.record, label, updatedAt: iso() };
      if (input.main === true) makeMain(stored);
      return ok(current(stored));
    },

    async listChoices(input) {
      const data = [...choices.values()]
        .filter(
          (c) =>
            c.tenantId === input.tenantId &&
            c.projectId === input.projectId &&
            c.envName === input.envName &&
            (input.includeRemoved === true || c.removedAt === undefined) &&
            (input.agentId === undefined || c.agentId === input.agentId) &&
            (input.flowId === undefined || c.flowId === input.flowId) &&
            (input.app === undefined || c.app === input.app) &&
            (input.toolId === undefined || c.toolId === input.toolId) &&
            ownedAsAsked(c, input.owners),
        )
        .sort(oldestFirst);
      return page(data, input.limit, input.cursor);
    },

    async getChoice(input) {
      const choice = choices.get(input.choiceId);
      return choice !== undefined && choice.tenantId === input.tenantId ? choice : null;
    },

    async setChoice(input) {
      const { tenantId, projectId, envName } = input;
      const target = targetOf(input);
      const outside = await outsideProject(input, target);
      if (outside !== undefined) return outside;
      const chosen = choosable(input, input.connectionId, 'connectionId');
      if (chosen.kind !== 'ok') return chosen;
      const connection = chosen.value;
      const aimed = await aimAndSet(input, target, connection);
      if (aimed.kind !== 'ok') return aimed;
      const { aim, set } = aimed.value;
      const owner = choiceOwner(input);
      const { app } = connection;
      const key: ChoiceKey = { tenantId, projectId, envName, target, app, aim, owner };
      const history = [...choices.values()].filter((c) => keyed(c, key));
      const live = history.find((c) => c.removedAt === undefined);
      if (live?.connectionId === connection.connectionId && sameSet(live.connectionIds, set)) {
        return ok(live);
      }
      const at = iso();
      const by = principalKey(input.by);
      if (live !== undefined) choices.set(live.choiceId, { ...live, removedAt: at, removedBy: by });
      const choice: ConnectionChoiceRecord = {
        ...target,
        choiceId: randomUUID(),
        tenantId,
        projectId,
        envName,
        app,
        ...aim,
        connectionId: connection.connectionId,
        ...(set !== undefined && { connectionIds: set }),
        ...(input.person !== undefined && { person: { userId: input.person.userId } }),
        version: Math.max(0, ...history.map((c) => c.version)) + 1,
        createdAt: at,
        createdBy: by,
      };
      choices.set(choice.choiceId, choice);
      return ok(choice);
    },

    async removeChoice(input) {
      const choice = choices.get(input.choiceId);
      if (
        choice === undefined ||
        choice.tenantId !== input.tenantId ||
        choice.removedAt !== undefined
      ) {
        return refuse('connection-choice-not-found', 'No such connection choice');
      }
      const removed = { ...choice, removedAt: iso(), removedBy: principalKey(input.by) };
      choices.set(choice.choiceId, removed);
      return ok(removed);
    },

    async listCandidates(input) {
      const owner = choiceOwner(input);
      const data = [...connections.values()]
        .map(current)
        .filter(
          (c) =>
            c.tenantId === input.tenantId &&
            (input.app === undefined || c.app === input.app) &&
            candidate(c, input.projectId, input.envName, owner),
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.connectionId.localeCompare(b.connectionId),
        )
        .map((c) => ({
          connectionId: c.connectionId,
          name: nameOf(c),
          app: c.app,
          accountLabel: c.account.label,
          state: c.state,
          ...(c.main === true && { main: true }),
        }));
      return page(data, input.limit, input.cursor);
    },

    async choiceNeeds(input) {
      const target = targetOf(input);
      const outside = await outsideProject(input, target);
      if (outside !== undefined) return outside;
      const { tools, unread = [] } = await targetTools(input, target);
      const data: ConnectionChoiceNeedRecord[] = [];
      for (const tool of [...tools].sort((a, b) => a.id.localeCompare(b.id))) {
        data.push(...needRecordsOf(tool, input.app));
      }
      return ok({ data, ...(unread.length > 0 && { unread: [...unread] }) });
    },

    async listChoicesForConnection(input) {
      const stored = connections.get(input.connectionId);
      const named = stored?.record.tenantId === input.tenantId ? stored.record : undefined;
      const data =
        named === undefined
          ? []
          : [...choices.values()]
              .filter(
                (c) =>
                  c.tenantId === input.tenantId &&
                  c.envName === input.envName &&
                  c.removedAt === undefined &&
                  (c.connectionId === named.connectionId ||
                    c.connectionIds?.includes(named.connectionId) === true) &&
                  ownerKey(choiceOwner(c)) === ownerKey(named.owner),
              )
              .sort(oldestFirst);
      return page(data, input.limit, input.cursor);
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

  /** The connection, marked as needing reconnecting, without its token. */
  function needsReconnecting(stored: StoredConnection, reason: string): 'needs-reconnecting' {
    stored.record = {
      ...stored.record,
      state: 'needs-reconnecting',
      stateReason: reason,
      updatedAt: iso(),
    };
    stored.token = undefined;
    return 'needs-reconnecting';
  }

  /** Whether a connection without a refresh token is within a minute of its access token's end. */
  function accessEnding(stored: StoredConnection): boolean {
    const ends = stored.record.accessEndsAt;
    return ends !== undefined && now() >= Date.parse(ends) - ACCESS_END_MARGIN_MS;
  }

  /**
   * The connection as a read finds it: a working one whose access is ending
   * reads as needing reconnecting (`access-expired`), with no call to the app.
   */
  function current(stored: StoredConnection): ConnectionRecord {
    if (stored.record.state === 'working' && accessEnding(stored)) {
      needsReconnecting(stored, 'access-expired');
    }
    return stored.record;
  }

  /**
   * The connection's token for one call, renewed first when asked or near
   * its expiry. One without a refresh token can't be renewed: within a
   * minute of its token's end it needs reconnecting (`access-expired`), and
   * asked to renew before then (`invalid-grant`), with no call to the app.
   */
  function tokenFor(
    stored: StoredConnection,
    name: string,
    renewFirst: boolean,
  ): ToolConnection | 'needs-reconnecting' {
    const c = stored.record;
    const token = stored.token;
    const margin = Math.min(MAX_RENEW_MARGIN_MS, ttlMs / 5);
    if (stored.noRefresh === true) {
      if (token === undefined || accessEnding(stored)) {
        return needsReconnecting(stored, 'access-expired');
      }
      if (renewFirst) return needsReconnecting(stored, 'invalid-grant');
    } else if (renewFirst || token === undefined || now() >= token.expiresAtMs - margin) {
      const answer = fake.renew?.({ connectionId: c.connectionId }) ?? 'ok';
      calls.push({ op: 'renew', connectionId: c.connectionId, outcome: answer });
      if (answer === 'unavailable') throw new ConnectionRenewError(name);
      if (answer === 'invalid-grant') return needsReconnecting(stored, 'invalid-grant');
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
      name: nameOf(c),
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

  /** A connection's name: its label, else its account's label. */
  function nameOf(c: ConnectionRecord): string {
    return c.label ?? c.account.label;
  }

  /**
   * A registration as a call's record names it: its label, else its app's
   * name and its id's first 8 characters, as a runtime does.
   */
  function registrationSeen(
    app: ConnectionAppRecord,
    entry: AppEntry,
  ): ConnectionPick['registration'] {
    return { id: app.appId, name: app.label ?? `${entry.name} (${app.appId.slice(0, 8)})` };
  }

  /**
   * A need's candidates: its owner's live connections of the app on a
   * registration that allows the project, in the env.
   */
  function candidatesOf(
    need: ConnectionNeed,
    owner: ConnectionOwner,
    input: Pick<ResolveConnectionsInput, 'tenantId' | 'projectId' | 'envName'>,
  ): ConnectionRecord[] {
    return [...connections.values()]
      .filter((s) => s.record.tenantId === input.tenantId && s.record.app === need.app)
      .map(current)
      .filter((c) => candidate(c, input.projectId, input.envName, owner));
  }

  /** The owner's live choice for the target and app: a tool's need's (`aim`), else the target's. */
  function liveChoice(
    input: Pick<ResolveConnectionsInput, 'tenantId' | 'projectId' | 'envName'>,
    target: ConnectionChoiceTarget,
    owner: ConnectionOwner,
    app: string,
    aim: ToolNeed | undefined,
  ): ConnectionChoiceRecord | undefined {
    const { tenantId, projectId, envName } = input;
    const key: ChoiceKey = { tenantId, projectId, envName, target, app, aim, owner };
    return [...choices.values()].find((c) => c.removedAt === undefined && keyed(c, key));
  }

  /**
   * Steps 1 to 4 for a need: the run's mailbox, when it's the owner's for
   * the app; the member of the tool's set the call names (`accounts`), when
   * the call's tool may take a set (`sets`); the tool's choice for the
   * need, a set's default; else the target's choice for the app. Every
   * choice is the owner's own. `outside`: the call named a connection that
   * isn't a member of the need's live set, for a need with no set, or for a
   * tool that may not take one now; it never falls back to the default.
   */
  function pickedFor(
    name: string,
    need: Need,
    owner: ConnectionOwner,
    input: ResolveConnectionsInput,
    sets: boolean,
  ): Picked | 'outside' | undefined {
    const bound = mailboxOf(need, input.mailbox);
    if (bound !== undefined) return { by: 'mailbox', connectionId: bound };
    if (input.target === undefined) return undefined;
    const target = choiceTarget(input.target);
    const aim = { toolId: input.toolId, need: name };
    const toolChoice = liveChoice(input, target, owner, need.app, aim);
    const named = input.accounts?.[name];
    if (named !== undefined) return sets ? namedMemberPick(toolChoice, named) : 'outside';
    const chosen = toolChoice ?? liveChoice(input, target, owner, need.app, undefined);
    if (chosen === undefined) return undefined;
    return {
      by: 'choice',
      connectionId: chosen.connectionId,
      choiceId: chosen.choiceId,
      ...(chosen.connectionIds !== undefined && { setSize: chosen.connectionIds.length }),
    };
  }

  /** The member of the tool's live set the call names: `outside` without a set, or not in it. */
  function namedMemberPick(
    toolChoice: ConnectionChoiceRecord | undefined,
    named: string,
  ): Picked | 'outside' {
    const members = toolChoice?.connectionIds ?? [];
    if (toolChoice === undefined || !members.includes(named)) return 'outside';
    const { choiceId } = toolChoice;
    return { by: 'named', connectionId: named, choiceId, setSize: members.length };
  }

  /** Several company connections, and none chosen: the turn stops, listing them. */
  function notChosen(
    name: string,
    entry: AppEntry,
    candidates: readonly ConnectionRecord[],
    input: ResolveConnectionsInput,
  ): Refused {
    const listed = candidates
      .map((c) => ({ connectionId: c.connectionId, name: nameOf(c) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.connectionId.localeCompare(b.connectionId));
    const has = `This project has ${listed.length} company ${entry.name} connections (${listed.map((c) => c.name).join(', ')})`;
    const target = input.target;
    const [kind, id, page] =
      target === undefined
        ? []
        : 'agentId' in target
          ? ['agent', target.agentId, 'Agents']
          : ['flow', target.flowId, 'Flows'];
    return {
      kind: 'refused',
      code: 'connection-not-chosen',
      name,
      app: entry.id,
      choices: listed,
      message:
        kind === undefined
          ? `${has}, and this call is no agent's or flow's, so none can be chosen for it.`
          : `${has}, and ${kind} ${id} has no choice of one. A project admin chooses it: Project, ${page}, ${id}, Connections, or kindgi connection-choices set.`,
    };
  }

  /**
   * Several of a person's connections, none main and none chosen: the turn
   * stops, counting them. Their names stay out of the record, and so do
   * the choices.
   */
  function personNotChosen(
    name: string,
    entry: AppEntry,
    count: number,
    input: ResolveConnectionsInput,
  ): Refused {
    const has = `This person has ${count} ${entry.name} connections that could be used`;
    const fix = `${has}, and none is their main: they make one their main`;
    const target = input.target;
    const of = target === undefined ? undefined : 'agentId' in target ? 'agent' : 'flow';
    return {
      kind: 'refused',
      code: 'connection-not-chosen',
      name,
      app: entry.id,
      message: of === undefined ? `${fix}.` : `${fix}, or choose one for this ${of}.`,
    };
  }

  /** Why the picked connection isn't a candidate any more. */
  function notCandidate(
    c: ConnectionRecord,
    entry: AppEntry,
    input: ResolveConnectionsInput,
  ): string {
    if (!LIVE.has(c.state)) return 'was disconnected';
    if (c.envName !== input.envName) return `is in env ${c.envName}, not ${input.envName}`;
    return `is on a ${entry.name} registration that no longer allows this project`;
  }

  /**
   * A need of its owner's, the company's or the run's person's: steps 1 to
   * 4 (`pickedFor`), else a person's main one, else the only candidate. One
   * of those that can't serve the call refuses, naming it if it's the
   * company's, and never falls back to another; a person's that a
   * reconnect would serve waits for it when the call can wait, as none at
   * all does. The runtime keeps, per run tree, agent or flow, and app, the
   * connection the first ready call took through a choice, even once the
   * choice changes or is removed; this reference, which has no run tree (a
   * call names its own run alone), answers each call from the current
   * choice.
   */
  function resolveOwned(
    name: string,
    need: Need,
    found: { readonly entry: AppEntry; readonly app: ConnectionAppRecord },
    owner: ConnectionOwner,
    input: ResolveConnectionsInput,
    sets: boolean,
  ): Resolved {
    const { entry, app } = found;
    const person = owner.kind === 'member';
    const candidates = candidatesOf(need, owner, input);
    const picked = pickedFor(name, need, owner, input, sets);
    // A name outside the set answers as no connection does.
    if (picked === 'outside') return missingRefusal(name, entry, undefined, need.permissions);
    const main = person && picked === undefined ? candidates.find((c) => c.main) : undefined;
    if (picked === undefined && main === undefined && candidates.length > 1) {
      return person
        ? personNotChosen(name, entry, candidates.length, input)
        : notChosen(name, entry, candidates, input);
    }
    const id = picked?.connectionId ?? main?.connectionId ?? candidates[0]?.connectionId;
    const by = picked?.by ?? (main !== undefined ? 'main' : person ? 'own' : 'only');
    const pick: ConnectionPick = {
      by,
      ...(picked?.choiceId !== undefined && { choiceId: picked.choiceId }),
      as: need.as,
      ...(picked?.setSize !== undefined && { setSize: picked.setSize }),
      registration: registrationSeen(app, entry),
    };
    if (id === undefined && person) return waitOrMissing(name, need, found, owner, input);
    // Only the owner's connection of the app is named: any other id answers as none does.
    const stored = id === undefined ? undefined : ownedOf(id, need, owner, input);
    if (stored === undefined) return missingRefusal(name, entry, undefined, need.permissions);
    const answer = served(stored, name, need, candidates, entry, input);
    if (!('why' in answer)) return { kind: 'ready', connection: answer, pick };
    if (person && answer.reconnect && input.waitMs > 0) {
      return waitOrMissing(name, need, found, owner, input, stored);
    }
    const subject = person
      ? by === 'mailbox'
        ? `The ${entry.name} mailbox this run reads`
        : `"${name}"'s ${entry.name} connection`
      : by === 'mailbox'
        ? `${nameOf(stored.record)}, the mailbox this run reads,`
        : nameOf(stored.record);
    return pickRefusal(name, entry, subject, by, answer);
  }

  /**
   * A person's need with no connection to serve it, or one a reconnect
   * would: the connect the call waits for, or `connection-missing` when it
   * can't wait.
   */
  function waitOrMissing(
    name: string,
    need: Need,
    found: { readonly entry: AppEntry; readonly app: ConnectionAppRecord },
    owner: ConnectionOwner,
    input: ResolveConnectionsInput,
    existing?: StoredConnection,
  ): Resolved {
    const lacks = need.permissions.filter((p) => !existing?.record.permissions.includes(p));
    if (input.waitMs <= 0) return missingRefusal(name, found.entry, existing, lacks);
    return {
      kind: 'wait',
      wait: {
        names: [name],
        entry: found.entry,
        app: found.app,
        owner,
        ...(existing !== undefined && { existing }),
        permissions: [...need.permissions],
      },
    };
  }

  /** The tenant's connection of the need's app with that id, if it's the owner's. */
  function ownedOf(
    id: string,
    need: Need,
    owner: ConnectionOwner,
    input: ResolveConnectionsInput,
  ): StoredConnection | undefined {
    const stored = connections.get(id);
    return stored?.record.tenantId === input.tenantId &&
      ownerKey(stored.record.owner) === ownerKey(owner) &&
      stored.record.app === need.app
      ? stored
      : undefined;
  }

  /** The picked connection's token, or why it can't serve the need. */
  function served(
    stored: StoredConnection,
    name: string,
    need: Need,
    candidates: readonly ConnectionRecord[],
    entry: AppEntry,
    input: ResolveConnectionsInput,
  ): ToolConnection | Unserved {
    const c = current(stored);
    if (!candidates.some((k) => k.connectionId === c.connectionId)) {
      return { why: notCandidate(c, entry, input), reconnect: false };
    }
    const lacks = need.permissions.filter((p) => !c.permissions.includes(p));
    if (lacks.length > 0) return { why: `lacks ${lacks.join(', ')}`, reconnect: true, lacks };
    const token =
      c.state === 'working'
        ? tokenFor(stored, name, input.renew?.includes(name) === true)
        : 'needs-reconnecting';
    return token === 'needs-reconnecting' ? { why: 'needs reconnecting', reconnect: true } : token;
  }

  /**
   * The picked connection can't serve the need: `subject` names the
   * company's by its name, and a person's only by whose it is; then how to
   * fix it.
   */
  function pickRefusal(
    name: string,
    entry: AppEntry,
    subject: string,
    by: ConnectionPick['by'],
    answer: Unserved,
  ): Refused {
    const chosen = by === 'choice' || by === 'named';
    const fixes = [
      ...(answer.reconnect ? ['reconnect it'] : []),
      ...(chosen ? [answer.reconnect ? 'or choose another' : 'choose another'] : []),
    ];
    return {
      kind: 'refused',
      code: 'connection-missing',
      name,
      app: entry.id,
      ...(answer.lacks !== undefined && { missing: answer.lacks }),
      message: [`${subject} ${answer.why}`, fixes.join(', ')].filter((p) => p !== '').join('; '),
    };
  }

  /**
   * One need: its token, a connect to wait for, or why it can't be met.
   * `sets`: the call's tool may take a set, so a name it gives counts;
   * else a name answers as one outside the set does.
   */
  function resolveOne(
    name: string,
    need: Need,
    input: ResolveConnectionsInput,
    sets: boolean,
  ): Resolved {
    const registration = registrationOf(name, need, input);
    if ('kind' in registration) return registration;
    const owner = ownerFor(name, need, registration.entry, input);
    if (owner.kind === 'refused') return owner;
    return resolveOwned(name, need, registration, owner, input, sets);
  }

  /**
   * Whether the call's tool, at the version its agent or flow resolves to
   * now, may take a set: a call that names none needs no answer, and a
   * name given by one that may not answers as one outside the set does.
   */
  async function takesSet(input: ResolveConnectionsInput): Promise<boolean> {
    const named = input.accounts !== undefined && Object.keys(input.accounts).length > 0;
    if (!named || input.target === undefined) return false;
    const { tools } = await targetTools(input, choiceTarget(input.target));
    const tool = tools.find((t) => t.id === input.toolId);
    return tool !== undefined && connectionSetRefusal(tool) === undefined;
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
    const picks: Record<string, ConnectionPick> = {};
    const waits = new Map<string, Wait>();
    const sets = await takesSet(input);
    for (const name of Object.keys(input.needs).sort()) {
      const resolved = resolveOne(name, input.needs[name] as Need, input, sets);
      if (resolved.kind === 'refused') return resolved;
      if (resolved.kind === 'ready') {
        ready[name] = resolved.connection;
        picks[name] = resolved.pick;
        continue;
      }
      // One request per connection, for all the call's needs of it: the one
      // they reconnect, else the owner's new one through the registration.
      const { existing, app, owner } = resolved.wait;
      const key = existing?.record.connectionId ?? `${app.appId}|${ownerKey(owner)}`;
      const wait = waits.get(key);
      if (wait === undefined) {
        waits.set(key, resolved.wait);
        continue;
      }
      wait.names.push(name);
      wait.permissions = union(wait.permissions, resolved.wait.permissions);
    }
    if (waits.size === 0) return { kind: 'ready', connections: ready, picks };
    return { kind: 'wait', requests: [...waits.values()].map((w) => waitingFor(w, input)) };
  }

  /**
   * A need's set a call may name from: its owner's choice for the tool's
   * need, when it's a set, with the members still candidates, by name, and
   * its default by its connection id. None for a need the run's mailbox
   * binds (step 1), a person's need in a run with no person, or a set none
   * of whose members is a candidate any more.
   */
  function setFor(
    need: string,
    spec: ConnectionNeed,
    toolId: string,
    target: ConnectionChoiceTarget,
    input: ConnectionAccountChoicesInput,
  ): AccountSet | undefined {
    if (mailboxOf(spec, input.mailbox) !== undefined) return undefined;
    if (spec.as === 'person' && input.person === undefined) return undefined;
    const owner = spec.as === 'person' ? choiceOwner(input) : COMPANY;
    const choice = liveChoice(input, target, owner, spec.app, { toolId, need });
    if (choice?.connectionIds === undefined) return undefined;
    const candidates = candidatesOf(spec, owner, input);
    const members = choice.connectionIds.flatMap((id) => {
      const c = candidates.find((k) => k.connectionId === id);
      return c === undefined ? [] : [{ name: nameOf(c), connectionId: id }];
    });
    if (members.length === 0) return undefined;
    const appName = entries.get(spec.app)?.name ?? spec.app;
    return { appName, members, default: choice.connectionId };
  }

  /** The tool's needs the call asks about whose choice is a set, each with it (`setFor`). */
  function setsOfTool(
    asked: ConnectionAccountChoicesInput['tools'][number],
    target: ConnectionChoiceTarget,
    input: ConnectionAccountChoicesInput,
  ): Record<string, AccountSet> {
    const sets: Record<string, AccountSet> = {};
    for (const [need, spec] of Object.entries(asked.needs)) {
      const set = setFor(need, spec, asked.toolId, target, input);
      if (set !== undefined) sets[need] = set;
    }
    return sets;
  }

  /**
   * Once per turn: each tool's needs whose choice for their owner is a set.
   * A tool that may not take one, at the version its agent or flow resolves
   * to now (`connectionSetRefusal`), is left out, as is one the target
   * doesn't have.
   */
  async function accountChoices(
    input: ConnectionAccountChoicesInput,
  ): Promise<ConnectionAccountChoices> {
    if (input.target === undefined) return {};
    const target = choiceTarget(input.target);
    const { tools } = await targetTools(input, target);
    const offered: Record<string, Record<string, AccountSet>> = {};
    for (const asked of input.tools) {
      const tool = tools.find((t) => t.id === asked.toolId);
      if (tool === undefined || connectionSetRefusal(tool) !== undefined) continue;
      const sets = setsOfTool(asked, target, input);
      if (Object.keys(sets).length > 0) offered[asked.toolId] = sets;
    }
    return offered;
  }

  // ---------------- seeding ----------------

  /** A seeded connection's label, unique among the live ones as a rename's is. */
  function seededLabel(input: SeedConnectionInput): { readonly label?: string } {
    if (input.label === undefined) return {};
    if (input.state !== 'removed' && labelTaken(input, input.label)) {
      throw new TypeError(`Another connection is named "${input.label}"`);
    }
    return { label: input.label };
  }

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
      // An owner, a person as the company, has one live connection per account.
      const held = accountConnection({ ...input, appId: app.appId }, input.owner, input.account.id);
      if (held !== undefined) {
        throw new TypeError('That owner already has a connection through the registration');
      }
      const label = seededLabel(input);
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
          ...label,
          permissions: [...input.permissions],
          state: input.state ?? 'working',
          ...(input.installationId !== undefined && { installationId: input.installationId }),
          connectedAt: at,
          createdAt: at,
          createdBy: 'seed',
          updatedAt: at,
        },
      };
      if (input.refreshToken === false) {
        if (entry.signIn.kind !== 'oauth2' || entry.signIn.refreshToken !== 'optional') {
          throw new TypeError(
            `${entry.name} gives refresh tokens: refreshToken false needs signIn.refreshToken 'optional'`,
          );
        }
        stored.noRefresh = true;
      }
      if (stored.record.state === 'working') issueFirstToken(stored, stored.noRefresh !== true);
      connections.set(stored.record.connectionId, stored);
      return stored.record;
    },
  };

  return { binding, resolver: { resolveConnections, accountChoices }, seed, calls };
}
