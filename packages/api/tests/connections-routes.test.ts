// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The connections routes over an in-memory binding: who reaches what, what
 * each route checks before the binding, and what it passes on.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { AppEntry, SignIn } from '@kindgi/connections';
import { github } from '@kindgi/connections/github';
import { google } from '@kindgi/connections/google';
import { microsoft } from '@kindgi/connections/microsoft';
import { texts } from '@kindgi/connections/texts';
import type { Cursor, EnvName, TenantId, UserId } from '@kindgi/types';

import type {
  ConnectRequestCreateInput,
  ConnectRequestRecord,
  ConnectionAppRecord,
  ConnectionBinding,
  ConnectionChoiceListInput,
  ConnectionChoiceNeeds,
  ConnectionChoiceRecord,
  ConnectionChoiceSetInput,
  ConnectionRecord,
} from '../src/connection-binding.js';
import type { HitlBinding } from '../src/hitl-binding.js';
import { createApp } from '../src/index.js';
import type { ReviewerBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { validateAgainst } from './support/openapi-schema.js';

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const ANA = 'user-ana';
const BEN = 'user-ben';
const ADMIN = 'user-admin';
const TOKENS: Record<string, Awaited<ReturnType<TokenResolver>>> = {
  ana: { tenantId: tenantA, userId: ANA as UserId },
  ben: { tenantId: tenantA, userId: BEN as UserId },
  admin: { tenantId: tenantA, userId: ADMIN as UserId, scopes: ['tenant-admin'] },
  /** The admin's `member` key: no admin action through it. */
  'admin-member-key': {
    tenantId: tenantA,
    userId: ADMIN as UserId,
    scopes: ['tenant-admin'],
    tokenRole: 'member',
  },
  bot: { tenantId: tenantA, serviceAccountId: 'sa-bot' },
  other: { tenantId: tenantB, userId: 'user-other' as UserId, scopes: ['tenant-admin'] },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;
const SECRET = { envName: 'local', name: 'ACME_GOOGLE_CLIENT_SECRET' };
const at = '2026-10-22T12:00:00.000Z';
/** The connection a second connect made its owner's main. */
const FIRST_CONNECTION = randomUUID();
/**
 * The needs of the agent `acme.support`'s tools, as `choiceNeeds` answers
 * them. GitHub's names no permissions, as a binding that doesn't read them answers.
 */
/** Numbers the test binding refuses a connect of, each with what it says. */
const NUMBER_REFUSALS: Record<string, Record<string, unknown>> = {
  '+15550000001': {
    code: 'inbound-in-use',
    message: "+15550000001's texts go to hooks.acme.example today",
    host: 'hooks.acme.example',
  },
  '+15550000002': {
    code: 'inbound-in-use',
    message: '+15550000002 is on the messaging profile Acme support',
    profile: 'Acme support',
  },
  '+15550000003': {
    code: 'number-in-use',
    message: '+15550000003 is live in env prod',
    appId: '7d0e2c55-2222-4b3c-9d4e-000000000002',
    envName: 'prod',
  },
  '+15550000004': {
    code: 'connection-app-refused',
    message: "Telnyx refused the registration's credential (401)",
  },
};
/** A connected number whose old inbound can't be put back. */
const STUCK_NUMBER = '+15550000009';

const NEEDS: ConnectionChoiceNeeds['data'] = [
  {
    toolId: 'acme.read-mail',
    need: 'mail',
    app: 'google',
    as: 'company',
    permissions: ['gmail.readonly'],
    set: { allowed: true },
  },
  {
    toolId: 'acme.read-own-mail',
    need: 'mail',
    app: 'google',
    as: 'person',
    permissions: ['gmail.readonly'],
    set: { allowed: true },
  },
  {
    toolId: 'acme.send-mail',
    need: 'mail',
    app: 'google',
    as: 'person',
    permissions: ['gmail.send'],
    set: { allowed: false, reason: 'changes' },
  },
  {
    toolId: 'acme.issues',
    need: 'repo',
    app: 'github',
    as: 'company',
    set: { allowed: false, reason: 'accounts-input' },
  },
];

/** A binding that keeps everything in maps, and records what the routes pass it. */
function memoryBinding(entries: readonly AppEntry[] = [google, github]) {
  const apps = new Map<string, ConnectionAppRecord>();
  const connections = new Map<string, ConnectionRecord>();
  const requests = new Map<string, ConnectRequestRecord>();
  const choices = new Map<string, ConnectionChoiceRecord>();
  const calls: Record<string, unknown[]> = {};
  const seen = (name: string, input: unknown) => {
    calls[name] = [...(calls[name] ?? []), input];
  };
  const refuse = (code: string, message: string, field?: string) => ({
    kind: 'err' as const,
    error: { code, message, ...(field !== undefined && { field }) } as never,
  });
  const ownerKey = (owner: ConnectionRecord['owner']) =>
    owner.kind === 'member' ? `member:${owner.userId}` : 'company';
  /** The same owner's, through the same registration in the same env. */
  const sameRegistration = (a: ConnectionRecord, b: ConnectionRecord) =>
    a.tenantId === b.tenantId &&
    a.appId === b.appId &&
    a.envName === b.envName &&
    ownerKey(a.owner) === ownerKey(b.owner);
  /** Whether a choice is one of those a read asks for: the company's, by default. */
  const ownedBy = (choice: ConnectionChoiceRecord, owners: ConnectionChoiceListInput['owners']) => {
    if (choice.person === undefined) return owners?.company ?? true;
    const person = owners?.person;
    return person === 'every' || person?.userId === choice.person.userId;
  };
  /** Another live connection of the app, owner and env has `label`, ignoring case. */
  const labelTaken = (
    of: Pick<ConnectionRecord, 'tenantId' | 'app' | 'owner' | 'envName'>,
    label: string,
    except?: string,
  ) =>
    [...connections.values()].some(
      (c) =>
        c.connectionId !== except &&
        c.tenantId === of.tenantId &&
        c.app === of.app &&
        c.envName === of.envName &&
        ownerKey(c.owner) === ownerKey(of.owner) &&
        c.state !== 'removed' &&
        c.label?.toLowerCase() === label.toLowerCase(),
    );
  /** Why a choice can't name the connection: a person's own is theirs, and never the company's. */
  const notChoosable = (
    connection: ConnectionRecord,
    person: ConnectionChoiceSetInput['person'],
  ) => {
    if (person !== undefined) {
      const theirs =
        connection.owner.kind === 'member' && connection.owner.userId === person.userId;
      if (!theirs) return refuse('connection-not-found', 'No such candidate', 'connectionId');
    } else if (connection.owner.kind === 'member') {
      return refuse(
        'bad-input',
        "This is a person's connection: a person chooses their own (person, or --mine).",
        'connectionId',
      );
    }
    return undefined;
  };
  /** A tool's need is the company's or each person's: the other owner's choice is refused. */
  const otherOwnersNeed = (input: ConnectionChoiceSetInput, connection: ConnectionRecord) => {
    const owned = NEEDS.find((n) => n.toolId === input.toolId && n.app === connection.app);
    if (owned === undefined || (owned.as === 'person') === (input.person !== undefined)) {
      return undefined;
    }
    const appName = entries.find((e) => e.id === connection.app)?.name ?? connection.app;
    const whose =
      owned.as === 'person'
        ? `each person's own ${appName} connection: a person chooses their own (person, or --mine).`
        : `the company's ${appName} connection: a project admin chooses it for the project, not each person.`;
    return refuse('bad-input', `${owned.toolId}'s ${owned.need} is ${whose}`, 'person');
  };
  const binding: ConnectionBinding = {
    entries: () => entries,
    // A page of `limit` at a time; the cursor is where the next page starts.
    async listApps(input) {
      seen('listApps', input);
      const listed = [...apps.values()].filter(
        (a) =>
          a.tenantId === input.tenantId &&
          (input.includeRemoved === true || a.removedAt === undefined),
      );
      const start = input.cursor === undefined ? 0 : Number(input.cursor);
      const end = start + input.limit;
      return {
        data: listed.slice(start, end),
        ...(end < listed.length && { nextCursor: String(end) as Cursor }),
      };
    },
    async getApp({ tenantId, appId }) {
      const app = apps.get(appId);
      return app?.tenantId === tenantId ? app : null;
    },
    async createApp(input) {
      seen('createApp', input);
      if (!['google', 'github', 'microsoft', 'texts'].includes(input.app)) {
        return refuse('connection-app-unknown-entry', `No entry "${input.app}"`);
      }
      const appId = randomUUID();
      const record: ConnectionAppRecord = {
        appId,
        tenantId: input.tenantId,
        app: input.app,
        ...(input.label !== undefined && { label: input.label }),
        ...(input.oauth2 !== undefined && { oauth2: input.oauth2 }),
        ...(input.token !== undefined && { token: input.token }),
        ...(input.projects !== undefined && { projects: input.projects }),
        redirectUrl: 'https://kindgi.acme.example/console/connect/callback',
        noticesUrl: `https://kindgi.acme.example/v1/connection-notices/${input.tenantId}/${appId}`,
        createdAt: at,
        updatedAt: at,
      };
      apps.set(appId, record);
      return { kind: 'ok', value: record };
    },
    async updateApp(input) {
      seen('updateApp', input);
      const app = apps.get(input.appId);
      if (app === undefined) return refuse('connection-app-not-found', 'no app');
      return {
        kind: 'ok',
        value: {
          ...app,
          ...(input.label !== undefined && { label: input.label }),
          ...(input.token !== undefined && { token: input.token }),
        },
      };
    },
    // A registration whose number's old inbound can't be put back is kept,
    // its connection `removing`; otherwise it's removed.
    async removeApp(input) {
      seen('removeApp', input);
      const app = apps.get(input.appId);
      const stuck = [...connections.values()].find(
        (c) => c.appId === input.appId && c.state !== 'removed' && c.account.label === STUCK_NUMBER,
      );
      if (app !== undefined && input.withConnections && stuck !== undefined) {
        connections.set(stuck.connectionId, { ...stuck, state: 'removing' });
        return {
          kind: 'err',
          error: {
            code: 'inbound-restore-failed',
            message: `${STUCK_NUMBER}'s old inbound couldn't be put back`,
            profile: 'Acme support',
          } as never,
        };
      }
      if (app !== undefined) apps.set(input.appId, { ...app, removedAt: at });
      return { kind: 'ok', value: { connectionsRemoved: input.withConnections ? 2 : 0 } };
    },
    async list(input) {
      seen('list', input);
      const data = [...connections.values()].filter(
        (c) =>
          c.tenantId === input.tenantId &&
          (input.ownerUserId === undefined ||
            (c.owner.kind === 'member' && c.owner.userId === input.ownerUserId)) &&
          (input.ownerKind === undefined || c.owner.kind === input.ownerKind),
      );
      return { data };
    },
    async get({ tenantId, connectionId }) {
      const connection = connections.get(connectionId);
      return connection?.tenantId === tenantId ? connection : null;
    },
    async disconnect(input) {
      seen('disconnect', input);
      const connection = connections.get(input.connectionId) as ConnectionRecord;
      if (connection.account.label === STUCK_NUMBER && input.skipInboundRestore !== true) {
        connections.set(input.connectionId, { ...connection, state: 'removing' });
        return {
          kind: 'err',
          error: {
            code: 'inbound-restore-failed',
            message: `${STUCK_NUMBER}'s old inbound couldn't be put back`,
            profile: 'Acme support',
          } as never,
        };
      }
      const removed: ConnectionRecord = {
        ...connection,
        state: 'removed',
        removedAt: at,
        removedReason: 'disconnected',
        withdrawn: 'at-app',
      };
      connections.set(input.connectionId, removed);
      return { kind: 'ok', value: removed };
    },
    async update(input) {
      seen('update', input);
      const connection = connections.get(input.connectionId) as ConnectionRecord;
      if (input.main === true) {
        // Their main through the registration in the env moves to it.
        for (const other of connections.values()) {
          if (other.main === true && sameRegistration(other, connection)) {
            const { main: _moved, ...rest } = other;
            connections.set(other.connectionId, rest);
          }
        }
        const made: ConnectionRecord = { ...connection, main: true, updatedAt: at };
        connections.set(input.connectionId, made);
        return { kind: 'ok', value: made };
      }
      const label = input.label as string;
      if (labelTaken(connection, label, input.connectionId)) {
        return refuse('connection-label-taken', 'Another connection has that name', 'label');
      }
      const renamed: ConnectionRecord = { ...connection, label, updatedAt: at };
      connections.set(input.connectionId, renamed);
      return { kind: 'ok', value: renamed };
    },
    async listChoices(input) {
      seen('listChoices', input);
      const data = [...choices.values()].filter(
        (choice) =>
          choice.tenantId === input.tenantId &&
          choice.projectId === input.projectId &&
          choice.envName === input.envName &&
          (input.toolId === undefined || choice.toolId === input.toolId) &&
          ownedBy(choice, input.owners) &&
          (input.includeRemoved === true || choice.removedAt === undefined),
      );
      return { data };
    },
    async getChoice({ tenantId, choiceId }) {
      const choice = choices.get(choiceId);
      return choice?.tenantId === tenantId ? choice : null;
    },
    async setChoice(input) {
      seen('setChoice', input);
      const connection = connections.get(input.connectionId);
      if (connection === undefined) {
        return refuse('connection-not-found', 'No such candidate', 'connectionId');
      }
      const notTheirs = notChoosable(connection, input.person);
      if (notTheirs !== undefined) return notTheirs;
      if (input.agentId === 'acme.elsewhere') {
        return refuse('agent-not-found', 'No such agent in the project');
      }
      const otherOwners = otherOwnersNeed(input, connection);
      if (otherOwners !== undefined) return otherOwners;
      const { agentId, flowId } = input;
      const choice = {
        choiceId: randomUUID(),
        tenantId: input.tenantId,
        projectId: input.projectId,
        envName: input.envName,
        ...(agentId !== undefined ? { agentId } : { flowId }),
        app: connection.app,
        ...(input.toolId !== undefined && { toolId: input.toolId, need: input.need ?? 'mail' }),
        connectionId: connection.connectionId,
        ...(input.connectionIds !== undefined && { connectionIds: input.connectionIds }),
        ...(input.person !== undefined && { person: input.person }),
        version: 1,
        createdAt: at,
        createdBy: `${input.by.kind}:${input.by.id}`,
      } as ConnectionChoiceRecord;
      choices.set(choice.choiceId, choice);
      return { kind: 'ok', value: choice };
    },
    async removeChoice(input) {
      seen('removeChoice', input);
      const choice = choices.get(input.choiceId) as ConnectionChoiceRecord;
      const removed = { ...choice, removedAt: at, removedBy: `${input.by.kind}:${input.by.id}` };
      choices.set(input.choiceId, removed);
      return { kind: 'ok', value: removed };
    },
    async listCandidates(input) {
      seen('listCandidates', input);
      const data = [...connections.values()]
        .filter(
          (c) =>
            c.tenantId === input.tenantId &&
            (input.person === undefined
              ? c.owner.kind === 'company'
              : c.owner.kind === 'member' && c.owner.userId === input.person.userId) &&
            (c.state === 'working' || c.state === 'needs-reconnecting'),
        )
        .map((c) => ({
          connectionId: c.connectionId,
          name: c.label ?? c.account.label,
          app: c.app,
          accountLabel: c.account.label,
          state: c.state,
          ...(c.main === true && { main: true }),
        }));
      return { data };
    },
    async choiceNeeds(input) {
      seen('choiceNeeds', input);
      if (input.agentId !== 'acme.support') {
        return refuse('agent-not-found', 'No such agent in the project');
      }
      return {
        kind: 'ok',
        value: {
          data: NEEDS.filter((n) => input.app === undefined || n.app === input.app),
          unread: ['acme.gone'],
        },
      };
    },
    async listChoicesForConnection(input) {
      seen('listChoicesForConnection', input);
      const data = [...choices.values()].filter(
        (choice) =>
          choice.tenantId === input.tenantId &&
          choice.envName === input.envName &&
          choice.removedAt === undefined &&
          (choice.connectionId === input.connectionId ||
            (choice.connectionIds ?? []).includes(input.connectionId)),
      );
      return { data };
    },
    async createRequest(input) {
      seen('createRequest', input);
      if (input.number !== undefined) return numberConnect(input, input.number);
      if (input.permissions.some((p) => !(p in google.permissions))) {
        return refuse('bad-input', 'Google has no such permission', 'permissions');
      }
      if (input.label !== undefined && labelTaken(input, input.label)) {
        return refuse('connection-label-taken', 'Another connection has that name', 'label');
      }
      if (input.reconnects !== undefined && !connections.has(input.reconnects)) {
        return refuse('connection-not-found', 'No such connection to reconnect', 'reconnects');
      }
      const requestId = randomUUID();
      const record: ConnectRequestRecord = {
        requestId,
        tenantId: input.tenantId,
        envName: input.envName,
        appId: randomUUID(),
        app: input.app,
        owner: input.owner,
        permissions: input.permissions,
        says: input.permissions.map((p) => google.permissions[p]?.says ?? p),
        ...(input.label !== undefined && { label: input.label }),
        ...(input.reconnects !== undefined && { reconnects: input.reconnects }),
        state: 'pending',
        connectUrl: `https://kindgi.acme.example/console/connect/requests/${requestId}`,
        expiresAt: '2026-10-22T13:00:00.000Z',
        createdAt: at,
        createdBy: `${input.by.kind}:${input.by.id}`,
      };
      requests.set(requestId, record);
      return { kind: 'ok', value: record };
    },
    async getRequest({ tenantId, requestId }) {
      const request = requests.get(requestId);
      return request?.tenantId === tenantId ? request : null;
    },
    async requestsForRun() {
      return [];
    },
    async startRequest(input) {
      seen('startRequest', input);
      const request = requests.get(input.requestId) as ConnectRequestRecord;
      requests.set(input.requestId, {
        ...request,
        startedBy: `${input.caller.kind}:${input.caller.id}`,
      });
      return {
        kind: 'ok',
        value: { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s-1' },
      };
    },
    async finishRequest(input) {
      seen('finishRequest', input);
      const request = [...requests.values()].find((r) => r.startedBy !== undefined);
      if (request === undefined) return refuse('connection-state-expired', 'start again');
      if (request.startedBy !== `${input.caller.kind}:${input.caller.id}`) {
        return refuse('connection-not-yours', 'Only whoever started it finishes it');
      }
      if (input.code === 'several') {
        const installations = [
          { installationId: '101', account: { id: '1', label: 'acme' } },
          { installationId: '102', account: { id: '2', label: 'acme-labs' } },
        ];
        const pending = { ...request, installations };
        requests.set(request.requestId, pending);
        return { kind: 'ok', value: { kind: 'pick-installation', request: pending } };
      }
      if (input.code === 'unreachable') {
        return {
          kind: 'err',
          error: {
            code: 'connection-installation-unreachable',
            message: "Your GitHub account doesn't reach an installation of the app",
            connectRequestId: request.requestId,
          },
        };
      }
      // `taken`: the name asked for was another connection's by the finish.
      const connection = {
        ...connectionOf(request.owner),
        ...(input.code === 'taken' && { label: 'Work mail 2' }),
      };
      connections.set(connection.connectionId, connection);
      return {
        kind: 'ok',
        value: {
          kind: 'connected',
          request: { ...request, state: 'connected', connectionId: connection.connectionId },
          connection,
          ...(input.code === 'taken' && { reconnected: false, labelTaken: 'Work mail' }),
          // `another`: a second account; `none-main`: another, with no main.
          ...(input.code === 'another' && {
            reconnected: false,
            main: { state: 'set', connectionId: FIRST_CONNECTION },
          }),
          ...(input.code === 'none-main' && { reconnected: false, main: { state: 'missing' } }),
        },
      };
    },
    async receiveNotice(input) {
      seen('receiveNotice', input);
      const signature = input.headers['x-acme-signature'];
      if (signature === 'good')
        return { kind: 'ok', value: { handled: 'removed', connections: 1 } };
      if (signature === 'store-down') {
        return refuse('connection-store-failed', 'the store is down');
      }
      return refuse('connection-notice-invalid', 'the signature does not match');
    },
  };

  /** A number's connect: refused by number, else connected at once, with no browser step. */
  function numberConnect(input: ConnectRequestCreateInput, number: string) {
    const refused = NUMBER_REFUSALS[number];
    if (refused !== undefined) return { kind: 'err' as const, error: refused as never };
    const connection: ConnectionRecord = {
      ...connectionOf(input.owner),
      app: 'texts',
      account: { id: `num-${number.slice(1)}`, label: number },
      permissions: input.permissions,
    };
    connections.set(connection.connectionId, connection);
    const requestId = randomUUID();
    const record: ConnectRequestRecord = {
      requestId,
      tenantId: input.tenantId,
      envName: input.envName,
      appId: connection.appId,
      app: input.app,
      owner: input.owner,
      permissions: input.permissions,
      says: input.permissions.map((p) => texts.permissions[p]?.says ?? p),
      state: 'connected',
      connectionId: connection.connectionId,
      connectUrl: `https://kindgi.acme.example/console/connect/${requestId}`,
      expiresAt: '2026-10-22T13:00:00.000Z',
      createdAt: at,
      createdBy: `${input.by.kind}:${input.by.id}`,
    };
    requests.set(requestId, record);
    return { kind: 'ok' as const, value: record };
  }

  function connectionOf(owner: ConnectionRecord['owner']): ConnectionRecord {
    return {
      connectionId: randomUUID(),
      tenantId: tenantA,
      envName: 'local' as EnvName,
      appId: randomUUID(),
      app: 'google',
      owner,
      account: {
        id: '1234',
        label: owner.kind === 'member' ? `${owner.userId}@acme.example` : 'acme',
      },
      permissions: ['gmail.send'],
      state: 'working',
      connectedAt: at,
      createdAt: at,
      createdBy: owner.kind === 'member' ? `user:${owner.userId}` : `user:${ADMIN}`,
      updatedAt: at,
    };
  }

  /** A stored connection, as a finished connect would leave it. */
  function connected(
    owner: ConnectionRecord['owner'],
    tenantId = tenantA,
    more: Partial<ConnectionRecord> = {},
  ): ConnectionRecord {
    const connection = { ...connectionOf(owner), tenantId, ...more };
    connections.set(connection.connectionId, connection);
    return connection;
  }

  return { binding, calls, connected, requests, choices, apps };
}

const runHandler = {} as RunHandlerBinding;

function makeApp(
  options: {
    reviewers?: ReviewerBinding;
    clientAddress?: (r: Request) => string | undefined;
    authzCheckBinding?: AuthzCheckBinding;
    entries?: readonly AppEntry[];
    /** The webhook endpoints, whose secrets a registration's key can't be. */
    webhookEndpoints?: readonly { endpointId: string; secretRef: typeof SECRET }[];
    /** Mount `/v1/tools`, publishing into `published`. */
    tools?: boolean;
  } = {},
) {
  const memory = memoryBinding(options.entries);
  const published: unknown[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    envName: 'local' as EnvName,
    connections: memory.binding,
    ...(options.webhookEndpoints !== undefined && {
      webhookEndpoints: {
        list: async () => ({
          data: options.webhookEndpoints?.map((e) => ({
            ...e,
            url: 'https://app.acme.example/hooks',
            events: ['run.finished'],
            filter: {},
            description: null,
          })),
        }),
      } as never,
    }),
    ...(options.reviewers !== undefined && {
      reviewerBinding: options.reviewers,
      hitlBinding: {} as HitlBinding,
    }),
    ...(options.authzCheckBinding !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: options.authzCheckBinding },
    }),
    ...(options.tools === true && {
      toolRegistry: {
        list: async () => ({ data: [] }),
        headExists: async () => false,
        get: async () => null,
        publish: async (input: { tool: { id: string; version: string } }) => {
          published.push(input);
          return { kind: 'ok', toolId: input.tool.id, version: input.tool.version };
        },
      } as never,
    }),
  });
  return { app, published, ...memory };
}

type App = ReturnType<typeof makeApp>['app'];

async function call(
  app: App,
  who: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${who}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
}

describe('GET /v1/connection-entries', () => {
  test('any member reads the apps this server knows: what each permission allows, not what it grants', async () => {
    const { app } = makeApp();
    const res = await call(app, 'ana', 'GET', '/v1/connection-entries');
    expect(res.status).toBe(200);
    const [first, second] = res.json.data;
    expect(first).toMatchObject({
      id: 'google',
      name: 'Google',
      owners: ['member', 'company'],
      signIn: { kind: 'oauth2' },
      setupGuide: google.setupGuide,
    });
    expect(first.permissions['gmail.send']).toEqual({ says: 'Send mail as you', changes: true });
    expect(second).toMatchObject({
      id: 'github',
      owners: ['company'],
      signIn: { kind: 'github-app' },
    });
    expect(JSON.stringify(res.json)).not.toContain('googleapis.com/auth');
  });

  test("each app says whether a registration names a directory, and what a disconnect withdraws there: Microsoft's has no default and withdraws nothing, Google's revoke is grant-wide and it reports removals", async () => {
    const oauth2 = microsoft.signIn as Extract<SignIn, { kind: 'oauth2' }>;
    const withDefault: AppEntry = {
      ...microsoft,
      id: 'acme-directory',
      signIn: { ...oauth2, tenant: { default: 'organizations' } },
    };
    const { app } = makeApp({ entries: [google, github, microsoft, withDefault] });
    const res = await call(app, 'ana', 'GET', '/v1/connection-entries');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      res.json.data.map((entry: Record<string, any>) => [entry.id, entry]),
    );
    expect(byId.microsoft.signIn).toEqual({ kind: 'oauth2', tenant: {} });
    expect(byId.microsoft.removal).toEqual({});
    expect(byId['acme-directory'].signIn).toEqual({
      kind: 'oauth2',
      tenant: { default: 'organizations' },
    });
    expect(byId.google.signIn).toEqual({ kind: 'oauth2' });
    expect(byId.google.removal).toEqual({
      revoke: 'oauth2-revoke',
      revokeIsGrantWide: true,
      notices: 'google-risc',
    });
    expect(byId.github.signIn).toEqual({ kind: 'github-app' });
    expect(byId.github.removal).toEqual({
      revoke: 'github-installation-token',
      notices: 'github-webhooks',
    });
  });

  test("a field an entry's tenant or removal carries that the schema doesn't list stays off the wire", async () => {
    const oauth2 = microsoft.signIn as Extract<SignIn, { kind: 'oauth2' }>;
    const ahead = {
      ...microsoft,
      id: 'acme-ahead',
      signIn: { ...oauth2, tenant: { default: 'organizations', region: 'eu' } },
      removal: { ...google.removal, reportsTo: 'acme-hook' },
    } as AppEntry;
    const { app } = makeApp({ entries: [ahead] });
    const res = await call(app, 'ana', 'GET', '/v1/connection-entries');
    expect(res.status).toBe(200);
    const [entry] = res.json.data;
    expect(entry.signIn).toEqual({ kind: 'oauth2', tenant: { default: 'organizations' } });
    expect(entry.removal).toEqual({
      revoke: 'oauth2-revoke',
      revokeIsGrantWide: true,
      notices: 'google-risc',
    });
  });
});

describe('/v1/connection-apps', () => {
  test("registers the tenant's own client, its secret by reference", async () => {
    const { app, calls } = makeApp();
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'google',
      label: 'Acme mail',
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: SECRET },
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      app: 'google',
      label: 'Acme mail',
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: SECRET },
      redirectUrl: 'https://kindgi.acme.example/console/connect/callback',
    });
    expect(calls.createApp?.[0]).toMatchObject({ by: { kind: 'user', id: ADMIN } });
    const read = await call(app, 'admin', 'GET', `/v1/connection-apps/${res.json.appId}`);
    expect(read.json.appId).toBe(res.json.appId);
    const listed = await call(app, 'admin', 'GET', '/v1/connection-apps');
    expect(listed.json).toMatchObject({ data: [{ appId: res.json.appId }], hasMore: false });
  });

  test("passes a registration's directory to the binding, and shows it", async () => {
    const { app, calls } = makeApp();
    const oauth2 = { clientId: 'c-1', clientSecret: SECRET, tenant: 'acme.onmicrosoft.com' };
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'microsoft',
      oauth2,
    });
    expect(res.status).toBe(201);
    expect(res.json.oauth2).toEqual(oauth2);
    expect(calls.createApp?.[0]).toMatchObject({ oauth2: { tenant: 'acme.onmicrosoft.com' } });
  });

  test("without an authorizer, a key's tenant-admin scope decides: a member key neither registers nor re-points an app", async () => {
    const { app, calls } = makeApp();
    const body = {
      app: 'google',
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: SECRET },
    };
    for (const who of ['ana', 'admin-member-key']) {
      const res = await call(app, who, 'POST', '/v1/connection-apps', body);
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('permission-denied');
    }
    expect(calls.createApp).toBeUndefined();
    const created = await call(app, 'admin', 'POST', '/v1/connection-apps', body);
    expect(created.status).toBe(201);
    const path = `/v1/connection-apps/${created.json.appId}`;
    const repoint = {
      oauth2: { clientId: 'elsewhere.apps.googleusercontent.com', clientSecret: SECRET },
    };
    for (const [method, sent] of [
      ['PATCH', repoint],
      ['GET', undefined],
      ['DELETE', undefined],
    ] as const) {
      const res = await call(app, 'admin-member-key', method, path, sent);
      expect(res.status).toBe(403);
    }
    expect((await call(app, 'ana', 'GET', '/v1/connection-apps')).status).toBe(403);
    expect(calls.updateApp).toBeUndefined();
    expect(calls.removeApp).toBeUndefined();
    expect((await call(app, 'admin', 'PATCH', path, repoint)).status).toBe(200);
  });

  test.each([
    ['no app', { label: 'x' }, 'app'],
    ['an app that is not an entry id', { app: 'Google' }, 'app'],
    ['a field it does not know', { app: 'google', scopes: ['x'] }, 'scopes'],
    [
      'a client secret that is not a reference',
      { app: 'google', oauth2: { clientId: 'c', clientSecret: 'plain' } },
      'oauth2.clientSecret',
    ],
    [
      'a field oauth2 does not know',
      { app: 'google', oauth2: { clientId: 'c', clientSecret: SECRET, region: 'eu' } },
      'oauth2.region',
    ],
    [
      "a tenant that isn't a string",
      { app: 'microsoft', oauth2: { clientId: 'c', clientSecret: SECRET, tenant: 7 } },
      'oauth2.tenant',
    ],
    [
      'an empty tenant',
      { app: 'microsoft', oauth2: { clientId: 'c', clientSecret: SECRET, tenant: '' } },
      'oauth2.tenant',
    ],
    ['a project twice', { app: 'google', projects: ['p-1', 'p-1'] }, 'projects'],
    ['every project spelled as null on a create', { app: 'google', projects: null }, 'projects'],
  ])('refuses a create with %s, naming the field', async (_what, body, field) => {
    const { app, calls } = makeApp();
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', body);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'bad-input', details: { field } });
    expect(calls.createApp).toBeUndefined();
  });

  test('a reserved `kindgi.` name as its secret is refused, made or changed, before the binding', async () => {
    const { app, calls } = makeApp();
    const held = { envName: 'local', name: 'kindgi.google-client' };
    const made = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'google',
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: held },
    });
    expect([made.status, made.json.error?.code]).toEqual([400, 'reserved-name-prefix']);
    expect(made.json.error.message).toContain('a connection app never names one');
    expect(calls.createApp).toBeUndefined();
    const created = await call(app, 'admin', 'POST', '/v1/connection-apps', { app: 'google' });
    const changed = await call(app, 'admin', 'PATCH', `/v1/connection-apps/${created.json.appId}`, {
      oauth2: { clientId: 'acme-client.apps.googleusercontent.com', clientSecret: held },
    });
    expect([changed.status, changed.json.error?.code]).toEqual([400, 'reserved-name-prefix']);
    expect(calls.updateApp).toBeUndefined();
  });

  test("answers the binding's refusal in the error body's code", async () => {
    const { app } = makeApp();
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', { app: 'acme' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('connection-app-unknown-entry');
  });

  test("an update can't change the app, and takes null for every project", async () => {
    const { app, calls } = makeApp();
    const created = await call(app, 'admin', 'POST', '/v1/connection-apps', { app: 'google' });
    const path = `/v1/connection-apps/${created.json.appId}`;
    const moved = await call(app, 'admin', 'PATCH', path, { app: 'github' });
    expect(moved.status).toBe(400);
    expect(moved.json.error.details).toEqual({ field: 'app' });
    const every = await call(app, 'admin', 'PATCH', path, { projects: null, label: 'All' });
    expect(every.status).toBe(200);
    expect(calls.updateApp?.[0]).toMatchObject({ projects: null, label: 'All' });
  });

  test('a removal takes withConnections, true or false only', async () => {
    const { app, calls } = makeApp();
    const path = `/v1/connection-apps/${randomUUID()}`;
    expect((await call(app, 'admin', 'DELETE', `${path}?withConnections=yes`)).status).toBe(400);
    const removed = await call(app, 'admin', 'DELETE', `${path}?withConnections=true`);
    expect(removed.json).toEqual({ connectionsRemoved: 2 });
    await call(app, 'admin', 'DELETE', path);
    expect(
      calls.removeApp?.map((i) => (i as { withConnections: boolean }).withConnections),
    ).toEqual([true, false]);
  });

  test('a list of registrations takes includeRemoved, true or false only', async () => {
    const { app, calls } = makeApp();
    await call(app, 'admin', 'GET', '/v1/connection-apps');
    await call(app, 'admin', 'GET', '/v1/connection-apps?includeRemoved=true');
    await call(app, 'admin', 'GET', '/v1/connection-apps?includeRemoved=false');
    expect(calls.listApps?.map((i) => (i as { includeRemoved?: boolean }).includeRemoved)).toEqual([
      undefined,
      true,
      undefined,
    ]);
    const res = await call(app, 'admin', 'GET', '/v1/connection-apps?includeRemoved=yes');
    expect(res.status).toBe(400);
    expect(res.json.error.details).toEqual({ field: 'includeRemoved' });
    expect(calls.listApps).toHaveLength(3);
  });

  test('an id that is not one is a 400, before the binding', async () => {
    const { app } = makeApp();
    const res = await call(app, 'admin', 'GET', '/v1/connection-apps/not-an-id');
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad-input');
  });
});

describe('POST /v1/connections (a connect from outside a run)', () => {
  test('a member connects their own account, under the env the server serves', async () => {
    const { app, calls } = makeApp();
    const res = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      app: 'google',
      owner: { kind: 'member', userId: ANA },
      envName: 'local',
      permissions: ['gmail.send'],
      says: ['Send mail as you'],
      state: 'pending',
    });
    expect(calls.createRequest?.[0]).toMatchObject({
      envName: 'local',
      owner: { kind: 'member', userId: ANA },
      by: { kind: 'user', id: ANA, tenantId: tenantA },
    });
  });

  test("only a tenant admin connects the company's account", async () => {
    const { app } = makeApp();
    const body = { app: 'google', permissions: ['gmail.send'], for: 'company' };
    const member = await call(app, 'ana', 'POST', '/v1/connections', body);
    expect(member.status).toBe(403);
    const admin = await call(app, 'admin', 'POST', '/v1/connections', body);
    expect(admin.status).toBe(201);
    expect(admin.json.owner).toEqual({ kind: 'company' });
  });

  test('a service account has no account of its own to connect', async () => {
    const { app } = makeApp();
    const res = await call(app, 'bot', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
    });
    expect(res.status).toBe(400);
    expect(res.json.error.details).toEqual({ field: 'for' });
  });

  test.each([
    ['no permissions', { app: 'google', permissions: [] }, 'permissions'],
    [
      'a permission twice',
      { app: 'google', permissions: ['gmail.send', 'gmail.send'] },
      'permissions',
    ],
    [
      'an appId that is not one',
      { app: 'google', appId: 'x', permissions: ['gmail.send'] },
      'appId',
    ],
    [
      'a reconnects that is not a connection id',
      { app: 'google', permissions: ['gmail.send'], reconnects: 'x' },
      'reconnects',
    ],
    [
      'a reconnects that is not a string',
      { app: 'google', permissions: ['gmail.send'], reconnects: 7 },
      'reconnects',
    ],
    [
      'an owner other than me or company',
      { app: 'google', permissions: ['gmail.send'], for: 'team' },
      'for',
    ],
    ['an empty label', { app: 'google', permissions: ['gmail.send'], label: '  ' }, 'label'],
    [
      'a label over 100 characters',
      { app: 'google', permissions: ['gmail.send'], label: 'a'.repeat(101) },
      'label',
    ],
    [
      'a label with a control character',
      { app: 'google', permissions: ['gmail.send'], label: 'Work\nmail' },
      'label',
    ],
    [
      'a label with a bidi override',
      { app: 'google', permissions: ['gmail.send'], label: 'Work\u202Elim' },
      'label',
    ],
    [
      'a label with a zero-width space',
      { app: 'google', permissions: ['gmail.send'], label: 'Work\u200Bmail' },
      'label',
    ],
    [
      'a label with a lone surrogate',
      { app: 'google', permissions: ['gmail.send'], label: 'Work\uD800mail' },
      'label',
    ],
    [
      'a label with a line separator',
      { app: 'google', permissions: ['gmail.send'], label: 'Work\u2028mail' },
      'label',
    ],
    [
      'a label with a Hangul filler',
      { app: 'google', permissions: ['gmail.send'], label: '\u3164' },
      'label',
    ],
    [
      'a label with a combining grapheme joiner',
      { app: 'google', permissions: ['gmail.send'], label: 'Work\u034Fmail' },
      'label',
    ],
    [
      'a label with a variation selector after a letter',
      { app: 'google', permissions: ['gmail.send'], label: 'Work\uFE0F' },
      'label',
    ],
    [
      'a label with a variation selector after a digit, outside a keycap',
      { app: 'google', permissions: ['gmail.send'], label: '1\uFE0F' },
      'label',
    ],
    [
      'a label that is not a string',
      { app: 'google', permissions: ['gmail.send'], label: 7 },
      'label',
    ],
  ])('refuses %s, naming the field', async (_what, body, field) => {
    const { app } = makeApp();
    const res = await call(app, 'ana', 'POST', '/v1/connections', body);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad-input');
    expect(res.json.error.details).toEqual({ field });
  });

  test("the binding's bad-input names its field too", async () => {
    const { app } = makeApp();
    const res = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['drive.everything'],
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'bad-input', details: { field: 'permissions' } });
  });

  test('takes the connection it reconnects; one the binding has no such connection for is a 404 naming the field', async () => {
    const { app, calls } = makeApp();
    const made = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
    });
    await call(app, 'ana', 'POST', `/v1/connections/requests/${made.json.requestId}/start`);
    const finished = await call(app, 'ana', 'POST', '/v1/connections/finish', { state: 's-1' });
    const connectionId = finished.json.connection.connectionId as string;
    const res = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.readonly'],
      reconnects: connectionId,
    });
    expect(res.status).toBe(201);
    expect(res.json.reconnects).toBe(connectionId);
    expect(calls.createRequest?.[1]).toMatchObject({ reconnects: connectionId });
    const unknown = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      reconnects: '00000000-0000-4000-8000-000000000999',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toMatchObject({
      code: 'connection-not-found',
      details: { field: 'reconnects' },
    });
  });

  test('takes a label for the connection it makes, trimmed, of up to 100 characters', async () => {
    const { app, calls } = makeApp();
    const res = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      label: '  Work mail  ',
    });
    expect(res.status).toBe(201);
    expect(res.json.label).toBe('Work mail');
    expect(calls.createRequest?.[0]).toMatchObject({ label: 'Work mail' });
    // An emoji keeps the variation selector that picks its look.
    const emoji = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      label: '\u2709\uFE0F Contact',
    });
    expect(emoji.status).toBe(201);
    expect(emoji.json.label).toBe('\u2709\uFE0F Contact');
    const keycap = await call(app, 'ben', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      label: '1\uFE0F\u20E3 Start',
    });
    expect(keycap.status).toBe(201);
    expect(keycap.json.label).toBe('1\uFE0F\u20E3 Start');
    // Characters, not UTF-16 units: 100 emoji are 200 units.
    const long = await call(app, 'ben', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      label: '\u{1F4EC}'.repeat(100),
    });
    expect(long.status).toBe(201);
  });

  test("a label another of the owner's connections has is the binding's 409, naming the field", async () => {
    const { app, connected } = makeApp();
    connected({ kind: 'member', userId: ANA }, tenantA, { label: 'Work mail' });
    const res = await call(app, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      label: 'work MAIL',
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({
      code: 'connection-label-taken',
      details: { field: 'label' },
    });
  });
});

describe('a connect request: read, start and finish', () => {
  async function requested(app: App, who: string, forWhom: 'me' | 'company' = 'me') {
    const res = await call(app, who, 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      for: forWhom,
    });
    return res.json.requestId as string;
  }

  test("a member's request is theirs alone: anyone else, an admin too, gets the same 404", async () => {
    const { app } = makeApp();
    const requestId = await requested(app, 'ana');
    const path = `/v1/connections/requests/${requestId}`;
    expect((await call(app, 'ana', 'GET', path)).status).toBe(200);
    for (const who of ['ben', 'admin', 'other']) {
      const res = await call(app, who, 'GET', path);
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe('connection-request-not-found');
    }
    expect((await call(app, 'ben', 'POST', `${path}/start`)).status).toBe(404);
  });

  test("the company's request is a tenant admin's", async () => {
    const { app } = makeApp();
    const requestId = await requested(app, 'admin', 'company');
    const path = `/v1/connections/requests/${requestId}`;
    expect((await call(app, 'admin', 'GET', path)).status).toBe(200);
    expect((await call(app, 'ana', 'GET', path)).status).toBe(404);
  });

  test("a request id that isn't a UUID is a 400, on the request and under it, before the binding", async () => {
    const { app, calls } = makeApp();
    for (const [method, path] of [
      ['GET', '/v1/connections/requests/not-a-uuid'],
      ['POST', '/v1/connections/requests/not-a-uuid/start'],
    ] as const) {
      const res = await call(app, 'ana', method, path);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatchObject({
        code: 'bad-input',
        message: '`requestId` must be a connect request id (a UUID)',
      });
    }
    expect(calls.startRequest).toBeUndefined();
  });

  test("the owner starts it, and gets the app's consent page", async () => {
    const { app, calls } = makeApp();
    const requestId = await requested(app, 'ana');
    const res = await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s-1',
    });
    expect(calls.startRequest?.[0]).toMatchObject({ caller: { kind: 'user', id: ANA } });
  });

  test("a GitHub App's start takes the installation picked, or a new one; the request lists the ones to pick", async () => {
    const { app, calls, requests } = makeApp();
    const requestId = await requested(app, 'ana');
    const installations = [
      { installationId: '101', account: { id: '1', label: 'acme' } },
      { installationId: '102', account: { id: '2', label: 'acme-labs' } },
    ];
    requests.set(requestId, {
      ...(requests.get(requestId) as ConnectRequestRecord),
      installations,
    });
    const read = await call(app, 'ana', 'GET', `/v1/connections/requests/${requestId}`);
    expect(read.json).toMatchObject({ state: 'pending', installations });
    expect(read.json.failure).toBeUndefined();

    const path = `/v1/connections/requests/${requestId}/start`;
    for (const body of [
      { installationId: '102' },
      { newInstallation: true },
      { newInstallation: false },
      {},
    ]) {
      expect((await call(app, 'ana', 'POST', path, body)).status).toBe(200);
    }
    const [picked, fresh, notFresh, none] = calls.startRequest ?? [];
    expect(picked).toMatchObject({ installationId: '102' });
    expect(picked).not.toHaveProperty('newInstallation');
    expect(fresh).toMatchObject({ newInstallation: true });
    expect(fresh).not.toHaveProperty('installationId');
    for (const neither of [notFresh, none]) {
      expect(neither).not.toHaveProperty('installationId');
      expect(neither).not.toHaveProperty('newInstallation');
    }
  });

  test("a start's body is checked for shape before the binding sees it", async () => {
    const { app, calls } = makeApp();
    const requestId = await requested(app, 'ana');
    const path = `/v1/connections/requests/${requestId}/start`;
    for (const [body, field] of [
      [{ installationId: '' }, 'installationId'],
      [{ installationId: 'x'.repeat(65) }, 'installationId'],
      [{ installationId: 101 }, 'installationId'],
      [{ newInstallation: 'yes' }, 'newInstallation'],
      [{ installationId: '101', newInstallation: true }, 'newInstallation'],
      [{ installation: '101' }, 'installation'],
    ] as const) {
      const res = await call(app, 'ana', 'POST', path, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatchObject({ code: 'bad-input', details: { field } });
    }
    const notAnObject = await call(app, 'ana', 'POST', path, ['101']);
    expect(notAnObject.status).toBe(400);
    expect(calls.startRequest).toBeUndefined();
  });

  test('whoever started it finishes it: the request and the new connection', async () => {
    const { app, calls } = makeApp();
    const requestId = await requested(app, 'ana');
    await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    const res = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's-1',
      code: 'code-1',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      kind: 'connected',
      request: { requestId, state: 'connected' },
      connection: { app: 'google', owner: { kind: 'member', userId: ANA }, state: 'working' },
    });
    // No approvals on this server: nothing said about a reviewer seat.
    expect(res.json.reviewerSeat).toBeUndefined();
    expect(calls.finishRequest?.[0]).toMatchObject({ state: 's-1', code: 'code-1' });
    expect(res.json).not.toHaveProperty('reconnected');
    expect(res.json).not.toHaveProperty('labelTaken');
    const other = await call(app, 'ben', 'POST', '/v1/connections/finish', { state: 's-1' });
    expect(other.status).toBe(403);
    expect(other.json.error.code).toBe('connection-not-yours');
  });

  test('a finish says whether it reconnected one already there, and the name it was to get when that was taken', async () => {
    const { app } = makeApp();
    const requestId = await requested(app, 'ana');
    await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    const res = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's-1',
      code: 'taken',
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      kind: 'connected',
      reconnected: false,
      labelTaken: 'Work mail',
      connection: { label: 'Work mail 2' },
    });
  });

  test('a finish by someone else is refused, and the access audit records it', async () => {
    const recorded: { action: Action; resource: string; decision: Decision }[] = [];
    const grant = (action: Action, r: ResourceRef): Decision => ({
      allowed: true,
      reason: 'test: granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    });
    const { app } = makeApp({
      authzCheckBinding: {
        check: async (_p, action, r) => grant(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => grant(action, r)),
        recordDecision: (_p, action, r, decision) => {
          recorded.push({ action, resource: `${r.type}:${r.id}`, decision });
        },
      },
    });
    const requestId = await requested(app, 'ana');
    await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    expect(recorded).toEqual([]);
    const other = await call(app, 'ben', 'POST', '/v1/connections/finish', { state: 's-1' });
    expect(other.status).toBe(403);
    expect(other.json.error.code).toBe('connection-not-yours');
    expect(recorded).toEqual([
      {
        action: 'write',
        resource: `tenant:${tenantA}`,
        decision: expect.objectContaining({ allowed: false, failing: 'actor' }),
      },
    ]);
  });

  test("a GitHub App's finish: several installations to pick from, or none the person reaches", async () => {
    const recorded: string[] = [];
    const { app } = makeApp({
      authzCheckBinding: {
        check: async () => ({ allowed: true, reason: 'test', evidence: {} as never }),
        checkBatch: async (_p, _a, rs) =>
          rs.map(() => ({ allowed: true, reason: 'test', evidence: {} as never })),
        recordDecision: (_p, action, r) => {
          recorded.push(`${action} ${r.type}:${r.id}`);
        },
      },
    });
    const requestId = await requested(app, 'ana');
    await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
    const pick = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's-1',
      code: 'several',
    });
    expect(pick.status).toBe(200);
    expect(pick.json).toMatchObject({
      kind: 'pick-installation',
      request: { requestId, state: 'pending', installations: [{ installationId: '101' }, {}] },
    });
    expect(pick.json.connection).toBeUndefined();
    expect(pick.json.request.failure).toBeUndefined();

    const none = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's-1',
      code: 'unreachable',
    });
    expect(none.status).toBe(403);
    expect(none.json.error).toMatchObject({
      code: 'connection-installation-unreachable',
      details: { connectRequestId: requestId },
    });
    expect(recorded).toEqual([`write tenant:${tenantA}`]);
  });

  test('a finish needs the state the app sent back, and takes only what the app sends', async () => {
    const { app } = makeApp();
    const noState = await call(app, 'ana', 'POST', '/v1/connections/finish', { code: 'c' });
    expect(noState.json.error.details).toEqual({ field: 'state' });
    const extra = await call(app, 'ana', 'POST', '/v1/connections/finish', {
      state: 's',
      scope: 'x',
    });
    expect(extra.json.error.details).toEqual({ field: 'scope' });
  });

  test('on a server with approvals, the finish says whether the member has a reviewer seat', async () => {
    const reviewers: ReviewerBinding = {
      resolveReviewer: async ({ userId }) => (userId === ANA ? ('rev-ana' as never) : null),
    };
    for (const [who, seat] of [
      ['ana', true],
      ['ben', false],
    ] as const) {
      const { app } = makeApp({ reviewers });
      const requestId = await requested(app, who);
      await call(app, who, 'POST', `/v1/connections/requests/${requestId}/start`);
      const res = await call(app, who, 'POST', '/v1/connections/finish', {
        state: 's-1',
        code: 'c',
      });
      expect(res.json.reviewerSeat).toBe(seat);
    }
  });
});

describe('the connections themselves', () => {
  test('a member lists their own; a tenant admin every one, or their own with owner=me', async () => {
    const { app, connected } = makeApp();
    const anas = connected({ kind: 'member', userId: ANA });
    const bens = connected({ kind: 'member', userId: BEN });
    const company = connected({ kind: 'company' });
    connected({ kind: 'member', userId: ANA }, tenantB);
    const ids = (res: { json: Record<string, any> }) =>
      (res.json.data as { connectionId: string }[]).map((c) => c.connectionId).sort();

    expect(ids(await call(app, 'ana', 'GET', '/v1/connections'))).toEqual([anas.connectionId]);
    expect(ids(await call(app, 'ana', 'GET', '/v1/connections?ownerKind=company'))).toEqual([]);
    expect(ids(await call(app, 'admin', 'GET', '/v1/connections'))).toEqual(
      [anas.connectionId, bens.connectionId, company.connectionId].sort(),
    );
    expect(ids(await call(app, 'admin', 'GET', '/v1/connections?ownerKind=company'))).toEqual([
      company.connectionId,
    ]);
    expect(ids(await call(app, 'admin', 'GET', '/v1/connections?owner=me'))).toEqual([]);
    expect(ids(await call(app, 'bot', 'GET', '/v1/connections'))).toEqual([]);
  });

  test.each([
    ['owner', 'someone'],
    ['ownerKind', 'team'],
    ['state', 'broken'],
    ['app', 'Google'],
    ['includeRemoved', 'yes'],
  ])('a list refuses %s=%s', async (name, value) => {
    const { app } = makeApp();
    const res = await call(app, 'ana', 'GET', `/v1/connections?${name}=${value}`);
    expect(res.status).toBe(400);
    expect(res.json.error.details).toEqual({ field: name });
  });

  test('state=removed lists removed ones', async () => {
    const { app, calls } = makeApp();
    await call(app, 'admin', 'GET', '/v1/connections?state=removed');
    expect(calls.list?.[0]).toMatchObject({ state: 'removed', includeRemoved: true });
  });

  test('includeRemoved=true lists removed ones with the others, and a state still narrows it', async () => {
    const { app, calls } = makeApp();
    await call(app, 'admin', 'GET', '/v1/connections?includeRemoved=true');
    await call(app, 'admin', 'GET', '/v1/connections?state=working&includeRemoved=true');
    await call(app, 'admin', 'GET', '/v1/connections?includeRemoved=false');
    await call(app, 'admin', 'GET', '/v1/connections?state=working');
    expect(calls.list?.[0]).toMatchObject({ includeRemoved: true });
    expect(calls.list?.[0]).not.toHaveProperty('state');
    expect(calls.list?.[1]).toMatchObject({ state: 'working', includeRemoved: true });
    expect(calls.list?.[2]).not.toHaveProperty('includeRemoved');
    expect(calls.list?.[3]).toMatchObject({ state: 'working' });
    expect(calls.list?.[3]).not.toHaveProperty('includeRemoved');
  });

  test("a connection is its owner's and a tenant admin's; anyone else gets the same 404", async () => {
    const { app, connected } = makeApp();
    const anas = connected({ kind: 'member', userId: ANA });
    const path = `/v1/connections/${anas.connectionId}`;
    expect((await call(app, 'ana', 'GET', path)).json).toMatchObject({
      connectionId: anas.connectionId,
      account: { id: '1234', label: 'user-ana@acme.example' },
    });
    expect((await call(app, 'admin', 'GET', path)).status).toBe(200);
    for (const who of ['ben', 'bot', 'other']) {
      const res = await call(app, who, 'GET', path);
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe('connection-not-found');
    }
    expect((await call(app, 'ben', 'DELETE', path)).status).toBe(404);
  });

  test('one the app gave no refresh token says when its access ends, and why it needs reconnecting', async () => {
    const { app, connected } = makeApp();
    const ends = { accessEndsAt: '2026-12-21T12:00:00.000Z' };
    const anas = connected({ kind: 'member', userId: ANA }, tenantA, {
      state: 'needs-reconnecting',
      stateReason: 'access-expired',
      ...ends,
    });
    const res = await call(app, 'ana', 'GET', `/v1/connections/${anas.connectionId}`);
    expect(res.json).toMatchObject({
      state: 'needs-reconnecting',
      stateReason: 'access-expired',
      ...ends,
    });
    const renews = connected({ kind: 'member', userId: BEN });
    const listed = await call(app, 'admin', 'GET', '/v1/connections');
    const of = (id: string) =>
      (listed.json.data as { connectionId: string; accessEndsAt?: string }[]).find(
        (c) => c.connectionId === id,
      );
    expect(of(anas.connectionId)).toMatchObject(ends);
    expect(of(renews.connectionId)).not.toHaveProperty('accessEndsAt');
  });

  test('its owner disconnects it: the removed record, never a token', async () => {
    const { app, calls, connected } = makeApp();
    const anas = connected({ kind: 'member', userId: ANA });
    const res = await call(app, 'ana', 'DELETE', `/v1/connections/${anas.connectionId}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      state: 'removed',
      removedReason: 'disconnected',
      withdrawn: 'at-app',
    });
    expect(calls.disconnect?.[0]).toMatchObject({ by: { kind: 'user', id: ANA } });
    expect(JSON.stringify(res.json)).not.toMatch(/token/i);
  });

  test('whoever may disconnect it renames it, trimmed; anyone else gets the same 404', async () => {
    const { app, calls, connected } = makeApp();
    const anas = connected({ kind: 'member', userId: ANA });
    const path = `/v1/connections/${anas.connectionId}`;
    expect((await call(app, 'ana', 'GET', path)).json).not.toHaveProperty('label');
    const res = await call(app, 'ana', 'PATCH', path, { label: '  Work mail ' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      connectionId: anas.connectionId,
      label: 'Work mail',
      account: { label: 'user-ana@acme.example' },
    });
    expect(calls.update?.[0]).toEqual({
      tenantId: tenantA,
      connectionId: anas.connectionId,
      label: 'Work mail',
      by: { kind: 'user', id: ANA, tenantId: tenantA },
    });
    expect((await call(app, 'ana', 'GET', path)).json.label).toBe('Work mail');
    expect((await call(app, 'admin', 'PATCH', path, { label: 'Ana' })).status).toBe(200);
    for (const who of ['ben', 'bot', 'other']) {
      const refused = await call(app, who, 'PATCH', path, { label: 'Mine now' });
      expect(refused.status).toBe(404);
      expect(refused.json.error.code).toBe('connection-not-found');
    }
    const company = connected({ kind: 'company' });
    const companyPath = `/v1/connections/${company.connectionId}`;
    expect((await call(app, 'ana', 'PATCH', companyPath, { label: 'Ours' })).status).toBe(404);
    expect((await call(app, 'admin', 'PATCH', companyPath, { label: 'Ours' })).status).toBe(200);
    expect(calls.update).toHaveLength(3);
  });

  test('a disconnected connection, or none, is a 404 before the binding', async () => {
    const { app, calls, connected } = makeApp();
    const removed = connected({ kind: 'member', userId: ANA }, tenantA, {
      state: 'removed',
      removedAt: at,
      removedReason: 'disconnected',
    });
    for (const id of [removed.connectionId, randomUUID()]) {
      const res = await call(app, 'ana', 'PATCH', `/v1/connections/${id}`, { label: 'Work' });
      expect(res.status).toBe(404);
      expect(res.json.error).toMatchObject({
        code: 'connection-not-found',
        details: { connectionId: id },
      });
    }
    const notAnId = await call(app, 'ana', 'PATCH', '/v1/connections/x', { label: 'Work' });
    expect(notAnId.status).toBe(400);
    expect(calls.update).toBeUndefined();
  });

  test("a label another of the owner's connections has, ignoring case, is a 409 naming the field", async () => {
    const { app, connected } = makeApp();
    connected({ kind: 'member', userId: ANA }, tenantA, { label: 'Work mail' });
    const second = connected({ kind: 'member', userId: ANA });
    const res = await call(app, 'ana', 'PATCH', `/v1/connections/${second.connectionId}`, {
      label: 'WORK mail',
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({
      code: 'connection-label-taken',
      details: { field: 'label' },
    });
  });

  test.each([
    ['no label', {}, 'label'],
    ['an empty label', { label: '' }, 'label'],
    ['a blank label', { label: ' \t ' }, 'label'],
    ['a label over 100 characters', { label: 'a'.repeat(101) }, 'label'],
    ['a label with a control character', { label: 'Work\u0007mail' }, 'label'],
    ['a label with a bidi override', { label: 'Work\u202Elim' }, 'label'],
    ['a label with a zero-width space', { label: 'Work\u200Bmail' }, 'label'],
    ['a label with a lone surrogate', { label: 'Work\uD800mail' }, 'label'],
    ['a label with a line separator', { label: 'Work\u2029mail' }, 'label'],
    ['a label with a Hangul filler', { label: '\u3164' }, 'label'],
    ['a label with a combining grapheme joiner', { label: 'Work\u034Fmail' }, 'label'],
    ['a label with a variation selector after a letter', { label: 'Work\uFE0F' }, 'label'],
    ['a null label', { label: null }, 'label'],
    ['an unknown field', { label: 'Work', account: 'x' }, 'account'],
  ])('a rename refuses %s before the binding, naming the field', async (_what, body, field) => {
    const { app, calls, connected } = makeApp();
    const anas = connected({ kind: 'member', userId: ANA });
    const res = await call(app, 'ana', 'PATCH', `/v1/connections/${anas.connectionId}`, body);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'bad-input', details: { field } });
    expect(calls.update).toBeUndefined();
  });
});

describe('POST /v1/connection-notices/{tenantId}/{appId}', () => {
  const path = `/v1/connection-notices/${tenantA}/${randomUUID()}`;
  const send = (app: App, signature: string, client = '203.0.113.9', to = path) =>
    app.request(to, {
      method: 'POST',
      headers: {
        'X-Acme-Signature': signature,
        'content-type': 'application/secevent+jwt',
        'x-forwarded-for': client,
      },
      body: 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln',
    });

  test('needs no bearer: the binding checks the exact bytes and the headers, named in lower case', async () => {
    const { app, calls } = makeApp();
    const res = await send(app, 'good');
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    const received = calls.receiveNotice?.[0] as {
      tenantId: string;
      headers: Record<string, string>;
      rawBody: Uint8Array;
    };
    expect(received.tenantId).toBe(tenantA);
    expect(received.headers['x-acme-signature']).toBe('good');
    expect(new TextDecoder().decode(received.rawBody)).toBe('eyJhbGciOiJSUzI1NiJ9.e30.c2ln');
  });

  test('every refusal gets the same 400, whatever was wrong', async () => {
    const { app, calls } = makeApp();
    const bodies = await Promise.all(
      [
        send(app, 'forged'),
        send(app, 'good', '203.0.113.9', `/v1/connection-notices/not-a-tenant/${randomUUID()}`),
      ].map(async (pending) => {
        const res = await pending;
        expect(res.status).toBe(400);
        const { error } = (await res.json()) as { error: Record<string, unknown> };
        return { code: error.code, message: error.message, details: error.details };
      }),
    );
    expect(bodies[0]).toEqual({
      code: 'connection-notice-invalid',
      message: 'The notice was not accepted',
      details: undefined,
    });
    expect(bodies[1]).toEqual(bodies[0]);
    // The malformed id never reached the binding.
    expect(calls.receiveNotice).toHaveLength(1);
  });

  test("the server's own trouble is a 503, and the app sends it again", async () => {
    const { app } = makeApp();
    const res = await send(app, 'store-down');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'connection-notice-unavailable',
    );
  });

  test('a client past its refusals this minute gets a 429; another client does not', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 60; i += 1) expect((await send(app, 'forged')).status).toBe(400);
    const limited = await send(app, 'forged');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect((await send(app, 'forged', '198.51.100.7')).status).toBe(400);
  });
});

/** An authorization store where Ana is an admin of `project` and Ben a member; anyone else, nothing. */
function projectRoles(project: string, recorded: string[] = []): AuthzCheckBinding {
  const roles: Record<string, 'admin' | 'member'> = { [ANA]: 'admin', [BEN]: 'member' };
  const decide = (principal: unknown, action: Action, r: ResourceRef): Decision => {
    const actor = (principal as { actor?: { id?: string } }).actor?.id ?? '';
    const role = r.type === 'project' && r.id === project ? roles[actor] : undefined;
    const allowed = role === 'admin' || (role === 'member' && action === 'read');
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not in the project',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  return {
    check: async (p, action, r) => decide(p, action, r),
    checkBatch: async (p, action, rs) => rs.map((r) => decide(p, action, r)),
    recordDecision: (_p, action, r, decision) => {
      if (!decision.allowed) recorded.push(`${action} ${r.type}:${r.id}`);
    },
  };
}

describe('/v1/connection-choices', () => {
  const project = randomUUID();

  function choicesApp(recorded: string[] = []) {
    const made = makeApp({ authzCheckBinding: projectRoles(project, recorded) });
    const company = made.connected({ kind: 'company' }, tenantA, { label: 'Support' });
    return { ...made, company };
  }

  test('members read, admins write, and anyone else is refused', async () => {
    const recorded: string[] = [];
    const { app, company } = choicesApp(recorded);
    const body = {
      projectId: project,
      agentId: 'acme.support',
      connectionId: company.connectionId,
    };

    const member = await call(app, 'ben', 'PUT', '/v1/connection-choices', body);
    expect(member.status).toBe(403);
    expect(member.json.error).toMatchObject({
      code: 'permission-denied',
      message: 'Choosing a connection takes a project admin.',
    });

    const set = await call(app, 'ana', 'PUT', '/v1/connection-choices', body);
    expect(set.status).toBe(200);
    expect(set.json).toEqual({
      choiceId: expect.any(String),
      projectId: project,
      envName: 'local',
      agentId: 'acme.support',
      app: 'google',
      connectionId: company.connectionId,
      version: 1,
      createdAt: at,
      createdBy: `user:${ANA}`,
    });

    const list = `/v1/connection-choices?projectId=${project}`;
    const read = await call(app, 'ben', 'GET', list);
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ data: [set.json], hasMore: false });

    const outsider = await call(app, 'bot', 'GET', list);
    expect(outsider.status).toBe(403);
    expect((await call(app, 'bot', 'PUT', '/v1/connection-choices', body)).status).toBe(403);
    const path = `/v1/connection-choices/${set.json.choiceId}`;
    // One who can't read the project hears what an unknown id gets.
    const unseen = await call(app, 'bot', 'DELETE', path);
    expect(unseen.status).toBe(404);
    expect(unseen.json.error).toMatchObject({
      code: 'connection-choice-not-found',
      details: { choiceId: set.json.choiceId },
    });

    const notAdmin = await call(app, 'ben', 'DELETE', path);
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.json.error.message).toBe('Removing a connection choice takes a project admin.');

    const removed = await call(app, 'ana', 'DELETE', path);
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ deleted: true });
    expect((await call(app, 'ben', 'GET', list)).json.data).toEqual([]);
    // A choice's history: the removed ones too, with who removed them.
    const history = await call(app, 'ben', 'GET', `${list}&includeRemoved=true`);
    expect(history.status).toBe(200);
    expect(history.json.data).toEqual([{ ...set.json, removedAt: at, removedBy: `user:${ANA}` }]);
    expect((await call(app, 'bot', 'GET', `${list}&includeRemoved=true`)).status).toBe(403);
    // The route's own refusals are in the access audit.
    expect(recorded).toEqual(Array(3).fill(`admin project:${project}`));
  });

  test("a project's members see a candidate's id and name; its admins see all of it", async () => {
    const { app, company } = choicesApp();
    const path = `/v1/connection-choices/candidates?projectId=${project}&app=google`;
    const admin = await call(app, 'ana', 'GET', path);
    expect(admin.status).toBe(200);
    expect(admin.json.data).toEqual([
      {
        connectionId: company.connectionId,
        name: 'Support',
        app: 'google',
        accountLabel: 'acme',
        state: 'working',
      },
    ]);
    const member = await call(app, 'ben', 'GET', path);
    expect(member.status).toBe(200);
    expect(member.json.data).toEqual([{ connectionId: company.connectionId, name: 'Support' }]);
    expect((await call(app, 'bot', 'GET', path)).status).toBe(403);
  });

  test('the routes pass the env this server serves, and the caller', async () => {
    const { app, calls, company } = choicesApp();
    await call(app, 'ana', 'PUT', '/v1/connection-choices', {
      projectId: project,
      flowId: 'acme.triage',
      connectionId: company.connectionId,
    });
    await call(
      app,
      'ben',
      'GET',
      `/v1/connection-choices?projectId=${project}&flowId=acme.triage&app=google&includeRemoved=true&limit=5`,
    );
    await call(app, 'ben', 'GET', `/v1/connection-choices/candidates?projectId=${project}`);
    expect(calls.setChoice).toEqual([
      {
        projectId: project,
        flowId: 'acme.triage',
        connectionId: company.connectionId,
        tenantId: tenantA,
        envName: 'local',
        by: { kind: 'user', id: ANA, tenantId: tenantA },
      },
    ]);
    expect(calls.listChoices).toEqual([
      {
        tenantId: tenantA,
        projectId: project,
        envName: 'local',
        flowId: 'acme.triage',
        app: 'google',
        // A member reads the company's choices and their own.
        owners: { company: true, person: { userId: BEN } },
        includeRemoved: true,
        limit: 5,
      },
    ]);
    expect(calls.listCandidates).toEqual([
      { tenantId: tenantA, projectId: project, envName: 'local', limit: 25 },
    ]);
  });

  test('without an authorization store, a tenant admin writes and any member reads', async () => {
    const { app, connected } = makeApp();
    const company = connected({ kind: 'company' });
    const body = {
      projectId: project,
      agentId: 'acme.support',
      connectionId: company.connectionId,
    };
    expect((await call(app, 'ana', 'PUT', '/v1/connection-choices', body)).status).toBe(403);
    expect(
      (await call(app, 'admin-member-key', 'PUT', '/v1/connection-choices', body)).status,
    ).toBe(403);
    expect((await call(app, 'admin', 'PUT', '/v1/connection-choices', body)).status).toBe(200);
    const read = await call(app, 'ana', 'GET', `/v1/connection-choices?projectId=${project}`);
    expect(read.json.data).toHaveLength(1);
    const candidates = await call(
      app,
      'ana',
      'GET',
      `/v1/connection-choices/candidates?projectId=${project}`,
    );
    expect(candidates.json.data).toEqual([{ connectionId: company.connectionId, name: 'acme' }]);
  });

  test.each([
    ['both agentId and flowId', { agentId: 'acme.support', flowId: 'acme.triage' }, undefined],
    ['neither agentId nor flowId', {}, undefined],
    ['an empty agentId', { agentId: '' }, 'agentId'],
    ['an unknown field', { agentId: 'acme.support', app: 'google' }, 'app'],
    [
      'a connectionId that is not a UUID',
      { agentId: 'acme.support', connectionId: 'support' },
      'connectionId',
    ],
  ])('a body with %s is bad-input, and the binding never sees it', async (_, more, field) => {
    const { app, calls, company } = choicesApp();
    const res = await call(app, 'ana', 'PUT', '/v1/connection-choices', {
      projectId: project,
      connectionId: company.connectionId,
      ...more,
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad-input');
    expect(res.json.error.details?.field).toBe(field);
    expect(calls.setChoice).toBeUndefined();
  });

  test("the binding's refusals: a person's connection, a non-candidate, an agent of another project", async () => {
    const { app, connected } = choicesApp();
    const mine = connected({ kind: 'member', userId: ANA as UserId });
    const person = await call(app, 'ana', 'PUT', '/v1/connection-choices', {
      projectId: project,
      agentId: 'acme.support',
      connectionId: mine.connectionId,
    });
    expect(person.status).toBe(400);
    expect(person.json.error).toMatchObject({
      code: 'bad-input',
      message: "This is a person's connection: a person chooses their own (person, or --mine).",
      details: { field: 'connectionId' },
    });

    const unknown = randomUUID();
    const missing = await call(app, 'ana', 'PUT', '/v1/connection-choices', {
      projectId: project,
      agentId: 'acme.support',
      connectionId: unknown,
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toMatchObject({
      code: 'connection-not-found',
      details: { connectionId: unknown, field: 'connectionId' },
    });

    const company = connected({ kind: 'company' });
    const elsewhere = await call(app, 'ana', 'PUT', '/v1/connection-choices', {
      projectId: project,
      agentId: 'acme.elsewhere',
      connectionId: company.connectionId,
    });
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.json.error).toMatchObject({
      code: 'agent-not-found',
      details: { agentId: 'acme.elsewhere' },
    });
  });

  test("a choice that is unknown, removed or another env's is connection-choice-not-found", async () => {
    const { app, choices, company } = choicesApp();
    const unknown = randomUUID();
    const missing = await call(app, 'ana', 'DELETE', `/v1/connection-choices/${unknown}`);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toMatchObject({
      code: 'connection-choice-not-found',
      message: `No connection choice with id "${unknown}"`,
      details: { choiceId: unknown },
    });
    const live = {
      choiceId: randomUUID(),
      tenantId: tenantA,
      projectId: project,
      agentId: 'acme.support',
      app: 'google',
      connectionId: company.connectionId,
      version: 1,
      createdAt: at,
      createdBy: `user:${ANA}`,
    };
    const staging = { ...live, choiceId: randomUUID(), envName: 'staging' as EnvName };
    const removed = { ...live, choiceId: randomUUID(), envName: 'local' as EnvName, removedAt: at };
    for (const choice of [staging, removed]) {
      choices.set(choice.choiceId, choice as ConnectionChoiceRecord);
      const res = await call(app, 'ana', 'DELETE', `/v1/connection-choices/${choice.choiceId}`);
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe('connection-choice-not-found');
    }
    const malformed = await call(app, 'ana', 'DELETE', '/v1/connection-choices/support');
    expect(malformed.status).toBe(400);
    expect(malformed.json.error.code).toBe('bad-input');
  });

  test.each([
    ['no projectId', '', 'projectId'],
    ['a projectId that is not a UUID', 'projectId=acme', 'projectId'],
    ['an app that is not an entry id', `projectId=${project}&app=Google!`, 'app'],
    ['both agentId and flowId', `projectId=${project}&agentId=a&flowId=f`, undefined],
    [
      'an includeRemoved that is not a boolean',
      `projectId=${project}&includeRemoved=yes`,
      'includeRemoved',
    ],
  ])('a list with %s is bad-input', async (_, query, field) => {
    const { app, calls } = choicesApp();
    const res = await call(app, 'ben', 'GET', `/v1/connection-choices?${query}`);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('bad-input');
    expect(res.json.error.details?.field).toBe(field);
    expect(calls.listChoices).toBeUndefined();
  });

  test('a candidates read with no projectId, or an unknown app, is bad-input', async () => {
    const { app, calls } = choicesApp();
    expect((await call(app, 'ben', 'GET', '/v1/connection-choices/candidates')).status).toBe(400);
    const res = await call(
      app,
      'ben',
      'GET',
      `/v1/connection-choices/candidates?projectId=${project}&app=Google!`,
    );
    expect(res.json.error).toMatchObject({ code: 'bad-input', details: { field: 'app' } });
    expect(calls.listCandidates).toBeUndefined();
  });
});

describe('several connections of an app', () => {
  const project = randomUUID();
  const choices = '/v1/connection-choices';

  /** Ana admins the project; Ben reads it and runs acme.support; the admin admins the tenant. */
  function runnerRoles(): AuthzCheckBinding {
    const decide = (principal: unknown, action: Action, r: ResourceRef): Decision => {
      const actor = (principal as { actor?: { id?: string } }).actor?.id ?? '';
      const allowed =
        (r.type === 'tenant' && actor === ADMIN && action === 'admin') ||
        (r.type === 'project' &&
          r.id === project &&
          (actor === ANA || (actor === BEN && action === 'read'))) ||
        (r.type === 'agent' &&
          r.id === 'acme.support' &&
          action === 'execute' &&
          (actor === ANA || actor === BEN));
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not granted',
        evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
      };
    };
    return {
      check: async (p, action, r) => decide(p, action, r),
      checkBatch: async (p, action, rs) => rs.map((r) => decide(p, action, r)),
      recordDecision: () => {},
    };
  }

  function severalApp() {
    const made = makeApp({ authzCheckBinding: runnerRoles() });
    const company = made.connected({ kind: 'company' }, tenantA, { label: 'Support' });
    const work = made.connected({ kind: 'member', userId: BEN as UserId }, tenantA, {
      label: 'Work',
      main: true,
    });
    const school = made.connected({ kind: 'member', userId: BEN as UserId }, tenantA, {
      label: 'School',
      appId: work.appId,
    });
    return { ...made, company, work, school };
  }

  test("PATCH main: only `true`, one change at a time, the person's own, never the company's", async () => {
    const { app, calls, connected } = makeApp();
    const work = connected({ kind: 'member', userId: ANA as UserId }, tenantA, {
      label: 'Work',
      main: true,
    });
    const school = connected({ kind: 'member', userId: ANA as UserId }, tenantA, {
      label: 'School',
      appId: work.appId,
    });
    const company = connected({ kind: 'company' });
    const path = (id: string) => `/v1/connections/${id}`;

    const off = await call(app, 'ana', 'PATCH', path(work.connectionId), { main: false });
    expect(off.status).toBe(400);
    expect(off.json.error).toMatchObject({
      code: 'bad-input',
      message: 'A main moves only by making another connection main.',
      details: { field: 'main' },
    });
    const both = await call(app, 'ana', 'PATCH', path(school.connectionId), {
      main: true,
      label: 'School mail',
    });
    expect(both.status).toBe(400);
    expect(both.json.error.message).toBe('`label` or `main`, one change at a time');
    const notTrue = await call(app, 'ana', 'PATCH', path(school.connectionId), { main: 'yes' });
    expect(notTrue.status).toBe(400);
    expect(notTrue.json.error).toMatchObject({ details: { field: 'main' } });

    const ours = await call(app, 'admin', 'PATCH', path(company.connectionId), { main: true });
    expect(ours.status).toBe(400);
    expect(ours.json.error).toMatchObject({
      code: 'bad-input',
      message:
        "The company has no main connection: its agents use the company's through their choices.",
      details: { field: 'main' },
    });
    // A tenant admin reaches Ana's connection, and still can't make it Ana's main.
    const byAdmin = await call(app, 'admin', 'PATCH', path(school.connectionId), { main: true });
    expect(byAdmin.status).toBe(400);
    expect(byAdmin.json.error).toMatchObject({
      code: 'bad-input',
      message: 'Only the person whose connection it is makes it their main.',
      details: { field: 'main' },
    });
    // Anyone it doesn't reach hears what an unknown id gets.
    const byBen = await call(app, 'ben', 'PATCH', path(school.connectionId), { main: true });
    expect(byBen.status).toBe(404);
    expect(calls.update).toBeUndefined();

    const made = await call(app, 'ana', 'PATCH', path(school.connectionId), { main: true });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ connectionId: school.connectionId, main: true });
    expect(calls.update).toEqual([
      {
        tenantId: tenantA,
        connectionId: school.connectionId,
        main: true,
        by: { kind: 'user', id: ANA, tenantId: tenantA },
      },
    ]);
    // `main` is only ever `true`: the one that was main has none now.
    const was = await call(app, 'ana', 'GET', path(work.connectionId));
    expect(was.status).toBe(200);
    expect(was.json).not.toHaveProperty('main');
  });

  test("a second connect's finish says which connection is their main", async () => {
    const { app } = makeApp();
    for (const [code, main] of [
      ['another', { state: 'set', connectionId: FIRST_CONNECTION }],
      ['none-main', { state: 'missing' }],
    ] as const) {
      const requested = await call(app, 'ana', 'POST', '/v1/connections', {
        app: 'google',
        permissions: ['gmail.send'],
        for: 'me',
      });
      const requestId = requested.json.requestId as string;
      await call(app, 'ana', 'POST', `/v1/connections/requests/${requestId}/start`);
      const res = await call(app, 'ana', 'POST', '/v1/connections/finish', { state: 's-1', code });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ kind: 'connected', reconnected: false, main });
      expect(res.json.main).toEqual(main);
    }
    // A first connection's finish says nothing of a main.
    const { app: fresh } = makeApp();
    const first = await call(fresh, 'ana', 'POST', '/v1/connections', {
      app: 'google',
      permissions: ['gmail.send'],
      for: 'me',
    });
    await call(fresh, 'ana', 'POST', `/v1/connections/requests/${first.json.requestId}/start`);
    const only = await call(fresh, 'ana', 'POST', '/v1/connections/finish', {
      state: 's-1',
      code: 'c-1',
    });
    expect(only.status).toBe(200);
    expect(only.json).not.toHaveProperty('main');
  });

  test("a choices read is the company's and the caller's own; owner=me, only theirs", async () => {
    const { app, calls } = severalApp();
    const list = `${choices}?projectId=${project}`;
    expect((await call(app, 'ben', 'GET', list)).status).toBe(200);
    expect((await call(app, 'ben', 'GET', `${list}&owner=me`)).status).toBe(200);
    expect((await call(app, 'admin', 'GET', list)).status).toBe(403);
    const narrowed = `${list}&agentId=acme.support&toolId=acme.read-mail`;
    expect((await call(app, 'ana', 'GET', narrowed)).status).toBe(200);
    expect(calls.listChoices?.map((input) => (input as ConnectionChoiceListInput).owners)).toEqual([
      { company: true, person: { userId: BEN } },
      { company: false, person: { userId: BEN } },
      { company: true, person: { userId: ANA } },
    ]);
    expect(calls.listChoices?.[2]).toMatchObject({
      agentId: 'acme.support',
      toolId: 'acme.read-mail',
    });

    const other = await call(app, 'ben', 'GET', `${list}&owner=someone`);
    expect(other.status).toBe(400);
    expect(other.json.error).toMatchObject({
      code: 'bad-input',
      message: "`owner` takes only `'me'`",
      details: { field: 'owner' },
    });
  });

  test("a tenant admin's choices read has every person's in it", async () => {
    const { app, calls } = makeApp();
    expect((await call(app, 'admin', 'GET', `${choices}?projectId=${project}`)).status).toBe(200);
    expect((calls.listChoices?.[0] as ConnectionChoiceListInput).owners).toEqual({
      company: true,
      person: 'every',
    });
  });

  test('candidates with owner=me: your own, in full, with your main; a service account has none', async () => {
    const { app, calls, work, school } = severalApp();
    const path = `${choices}/candidates?projectId=${project}&app=google&owner=me`;
    const mine = await call(app, 'ben', 'GET', path);
    expect(mine.status).toBe(200);
    expect(mine.json.data).toEqual([
      {
        connectionId: work.connectionId,
        name: 'Work',
        app: 'google',
        accountLabel: `${BEN}@acme.example`,
        state: 'working',
        main: true,
      },
      {
        connectionId: school.connectionId,
        name: 'School',
        app: 'google',
        accountLabel: `${BEN}@acme.example`,
        state: 'working',
      },
    ]);
    expect(calls.listCandidates?.[0]).toMatchObject({ person: { userId: BEN } });
    // Without it, today's company read: a member sees a candidate's id and name.
    const company = await call(app, 'ben', 'GET', path.replace('&owner=me', ''));
    expect(company.json.data).toEqual([{ connectionId: expect.any(String), name: 'Support' }]);
    expect(calls.listCandidates?.[1]).not.toHaveProperty('person');
  });

  test("a person's choice is theirs alone, and needs only what running the agent takes", async () => {
    const { app, calls, work, school } = severalApp();
    const body = {
      projectId: project,
      agentId: 'acme.support',
      toolId: 'acme.read-own-mail',
      need: 'mail',
      connectionId: work.connectionId,
      connectionIds: [work.connectionId, school.connectionId],
      person: { userId: BEN },
    };
    const forBen = await call(app, 'ana', 'PUT', choices, body);
    expect(forBen.status).toBe(400);
    expect(forBen.json.error).toMatchObject({
      code: 'bad-input',
      message: 'A person makes their own choices.',
      details: { field: 'person' },
    });
    const elsewhere = await call(app, 'ben', 'PUT', choices, { ...body, agentId: 'acme.other' });
    expect(elsewhere.status).toBe(403);

    const set = await call(app, 'ben', 'PUT', choices, body);
    expect(set.status).toBe(200);
    expect(set.json).toEqual({
      choiceId: expect.any(String),
      projectId: project,
      envName: 'local',
      agentId: 'acme.support',
      app: 'google',
      toolId: 'acme.read-own-mail',
      need: 'mail',
      connectionId: work.connectionId,
      connectionIds: [work.connectionId, school.connectionId],
      person: { userId: BEN },
      version: 1,
      createdAt: at,
      createdBy: `user:${BEN}`,
    });
    expect(calls.setChoice?.[0]).toMatchObject({
      toolId: 'acme.read-own-mail',
      need: 'mail',
      connectionIds: [work.connectionId, school.connectionId],
      person: { userId: BEN },
    });

    // Removing it is theirs too: to anyone else, an admin as well, it isn't there.
    const path = `${choices}/${set.json.choiceId}`;
    for (const who of ['ana', 'admin']) {
      const refused = await call(app, who, 'DELETE', path);
      expect(refused.status).toBe(404);
      expect(refused.json.error.code).toBe('connection-choice-not-found');
    }
    const removed = await call(app, 'ben', 'DELETE', path);
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ deleted: true });
  });

  test("a tool's choice is its need's owner's: the company's for each person's own need, or a person's for the company's, is the binding's 400", async () => {
    const { app, calls, company, work } = severalApp();
    const base = { projectId: project, agentId: 'acme.support' };
    const forPeople = await call(app, 'ana', 'PUT', choices, {
      ...base,
      toolId: 'acme.read-own-mail',
      connectionId: company.connectionId,
    });
    expect(forPeople.status).toBe(400);
    expect(forPeople.json.error).toMatchObject({
      code: 'bad-input',
      message:
        "acme.read-own-mail's mail is each person's own Google connection: a person chooses their own (person, or --mine).",
      details: { field: 'person' },
    });
    const forCompany = await call(app, 'ben', 'PUT', choices, {
      ...base,
      toolId: 'acme.read-mail',
      connectionId: work.connectionId,
      person: { userId: BEN },
    });
    expect(forCompany.status).toBe(400);
    expect(forCompany.json.error).toMatchObject({
      code: 'bad-input',
      message:
        "acme.read-mail's mail is the company's Google connection: a project admin chooses it for the project, not each person.",
      details: { field: 'person' },
    });
    expect(calls.setChoice).toHaveLength(2);
  });

  test("a choice body's tool, need and set are checked before the binding", async () => {
    const { app, calls, company } = severalApp();
    const base = {
      projectId: project,
      agentId: 'acme.support',
      connectionId: company.connectionId,
    };
    const other = randomUUID();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ need: 'mail' }, "`need` is a tool's: name the tool (`toolId`)", 'need'],
      [
        { connectionIds: [company.connectionId, other] },
        'A set of connections is for one tool: name it.',
        'connectionIds',
      ],
      [
        { toolId: 'acme.read-mail', connectionIds: [company.connectionId] },
        'A set holds 2 to 10 different connections.',
        'connectionIds',
      ],
      [
        { toolId: 'acme.read-mail', connectionIds: [company.connectionId, company.connectionId] },
        'A set holds 2 to 10 different connections.',
        'connectionIds',
      ],
      [
        {
          toolId: 'acme.read-mail',
          connectionIds: [company.connectionId, ...Array.from({ length: 10 }, () => randomUUID())],
        },
        'A set holds 2 to 10 different connections.',
        'connectionIds',
      ],
      [
        { toolId: 'acme.read-mail', connectionIds: [other, randomUUID()] },
        'The default must be one of the set.',
        'connectionIds',
      ],
      [{ toolId: '' }, '`toolId` must be a non-empty string', 'toolId'],
      [{ person: { id: BEN } }, '`person` must be `{userId}`: you', 'person'],
    ];
    for (const [more, message, field] of cases) {
      const res = await call(app, 'ana', 'PUT', choices, { ...base, ...more });
      expect(res.status, message).toBe(400);
      expect(res.json.error).toMatchObject({ code: 'bad-input', message, details: { field } });
    }
    expect(calls.setChoice).toBeUndefined();
  });

  test("needs: each tool's need of an app, the permissions it asks for, whether it may take a set, and the tools it couldn't read", async () => {
    const { app, calls } = severalApp();
    const path = `${choices}/needs?projectId=${project}&agentId=acme.support`;
    const res = await call(app, 'ben', 'GET', `${path}&app=google`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      data: [
        {
          toolId: 'acme.read-mail',
          need: 'mail',
          app: 'google',
          as: 'company',
          permissions: ['gmail.readonly'],
          set: { allowed: true },
        },
        {
          toolId: 'acme.read-own-mail',
          need: 'mail',
          app: 'google',
          as: 'person',
          permissions: ['gmail.readonly'],
          set: { allowed: true },
        },
        {
          toolId: 'acme.send-mail',
          need: 'mail',
          app: 'google',
          as: 'person',
          permissions: ['gmail.send'],
          set: { allowed: false, reason: 'changes' },
        },
      ],
      unread: ['acme.gone'],
    });
    const github = await call(app, 'ben', 'GET', `${path}&app=github`);
    expect(github.json.data).toEqual([NEEDS[3]]);
    expect(github.json.data[0]).not.toHaveProperty('permissions');
    expect(calls.choiceNeeds?.[0]).toMatchObject({
      agentId: 'acme.support',
      projectId: project,
      envName: 'local',
      app: 'google',
    });

    const noTarget = await call(app, 'ben', 'GET', `${choices}/needs?projectId=${project}`);
    expect(noTarget.status).toBe(400);
    expect(noTarget.json.error.message).toBe(
      'Name whose tools to read: `agentId` or `flowId`, one of them',
    );
    const unknown = await call(
      app,
      'ben',
      'GET',
      `${choices}/needs?projectId=${project}&agentId=acme.elsewhere`,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toMatchObject({
      code: 'agent-not-found',
      details: { agentId: 'acme.elsewhere' },
    });
    expect((await call(app, 'bot', 'GET', path)).status).toBe(403);
  });

  test("needs reads only what it declares: `owner` and `toolId` aren't its, so they're ignored", async () => {
    const { app, calls } = severalApp();
    const path = `${choices}/needs?projectId=${project}&agentId=acme.support`;
    for (const extra of ['&owner=me', '&owner=someone', '&toolId=acme.issues']) {
      const res = await call(app, 'ben', 'GET', `${path}${extra}`);
      expect(res.status, extra).toBe(200);
      expect(res.json, extra).toEqual({ data: NEEDS, unread: ['acme.gone'] });
    }
    expect(calls.choiceNeeds).toHaveLength(3);
    for (const input of calls.choiceNeeds ?? []) {
      expect(input).toEqual({
        agentId: 'acme.support',
        tenantId: tenantA,
        projectId: project,
        envName: 'local',
      });
    }
  });

  test("an approval's connection reads three ways: the company's, a person's, and one from before `as`", () => {
    const shapes = [
      {
        app: 'google',
        appName: 'Google',
        as: 'company',
        account: 'support@acme.example',
        name: 'Support',
      },
      { app: 'google', appName: 'Google', as: 'person' },
      { app: 'google', appName: 'Google', account: 'ana@acme.example' },
    ];
    for (const shape of shapes) {
      expect(validateAgainst('ApprovalConnection', shape), shape.as ?? 'before').toEqual([]);
    }
    const other = { app: 'google', appName: 'Google', as: 'team' };
    expect(validateAgainst('ApprovalConnection', other)).not.toEqual([]);
  });

  test("an approval's connection can give the connection's id, a person's or the company's", () => {
    const connectionId = '6f1c2b8e-4d3a-4f5e-9a7b-0c1d2e3f4a5b';
    const shapes = [
      { app: 'google', appName: 'Google', as: 'person', connectionId },
      {
        app: 'google',
        appName: 'Google',
        as: 'company',
        account: 'support@acme.example',
        name: 'Support',
        connectionId,
      },
    ];
    for (const shape of shapes) {
      expect(validateAgainst('ApprovalConnection', shape), shape.as).toEqual([]);
    }
    const notAnId = { app: 'google', appName: 'Google', as: 'person', connectionId: 7 };
    expect(validateAgainst('ApprovalConnection', notAnId)).not.toEqual([]);
  });

  test("a connection's choices: its owner's and a tenant admin's to read; anyone else gets the same 404", async () => {
    const { app, calls, work, school } = severalApp();
    const set = await call(app, 'ben', 'PUT', choices, {
      projectId: project,
      agentId: 'acme.support',
      toolId: 'acme.read-own-mail',
      connectionId: work.connectionId,
      connectionIds: [work.connectionId, school.connectionId],
      person: { userId: BEN },
    });
    expect(set.status).toBe(200);
    // A set's member is named by it, as its default is.
    for (const connection of [work, school]) {
      const path = `/v1/connections/${connection.connectionId}/choices`;
      for (const who of ['ben', 'admin']) {
        const res = await call(app, who, 'GET', path);
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ data: [set.json], hasMore: false });
      }
      for (const who of ['ana', 'bot', 'other']) {
        const refused = await call(app, who, 'GET', path);
        expect(refused.status).toBe(404);
        expect(refused.json.error.code).toBe('connection-not-found');
      }
    }
    expect(calls.listChoicesForConnection?.[0]).toMatchObject({
      tenantId: tenantA,
      envName: 'local',
      connectionId: work.connectionId,
    });
    const notAnId = await call(app, 'ben', 'GET', '/v1/connections/not-an-id/choices');
    expect(notAnId.status).toBe(400);
  });
});

describe("a texts connection: a number, with the provider account's key", () => {
  const ENTRIES = [google, github, texts];
  const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
  const TOKEN = {
    provider: 'telnyx' as const,
    apiKey: { envName: 'local' as EnvName, name: 'ACME_TELNYX_KEY' },
    publicKey: PUBLIC_KEY,
  };
  const NUMBER = '+15551234567';

  test('the entry: a token sign-in with its providers, and a removal that restores the inbound', async () => {
    const { app } = makeApp({ entries: ENTRIES });
    const res = await call(app, 'ana', 'GET', '/v1/connection-entries');
    const entry = res.json.data.find((e: { id: string }) => e.id === 'texts');
    expect(entry).toEqual({
      id: 'texts',
      name: 'Texts',
      owners: ['company'],
      signIn: { kind: 'token', providers: ['telnyx'] },
      permissions: {
        'texts.reply': { says: 'Answer the people who text this number', changes: true },
        'texts.send': { says: 'Text people from this number', changes: true },
      },
      removal: { revoke: 'restore-inbound' },
      setupGuide: '/guides/connections/texts/',
    });
    expect(validateAgainst('ConnectionEntry', entry)).toEqual([]);
  });

  test('a registration takes `token`: the provider, its key by reference and the public key, shown back the same way', async () => {
    const { app, calls } = makeApp({ entries: ENTRIES });
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: TOKEN,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.token).toEqual(TOKEN);
    expect(res.json).not.toHaveProperty('oauth2');
    expect(calls.createApp?.[0]).toMatchObject({ app: 'texts', token: TOKEN });
    expect(validateAgainst('ConnectionApp', res.json)).toEqual([]);
    const read = await call(app, 'admin', 'GET', `/v1/connection-apps/${res.json.appId}`);
    expect(read.json.token).toEqual(TOKEN);
  });

  test.each([
    [
      'a 31-byte public key',
      { publicKey: Buffer.alloc(31, 7).toString('base64') },
      'token.publicKey',
    ],
    [
      'a 33-byte public key',
      { publicKey: Buffer.alloc(33, 7).toString('base64') },
      'token.publicKey',
    ],
    ['a public key not in base64', { publicKey: `${'-'.repeat(43)}=` }, 'token.publicKey'],
    ['a provider the server has no adapter for', { provider: 'twilio' }, 'token.provider'],
    ['no key', { apiKey: undefined }, 'token.apiKey'],
    ['a field it has no use for', { webhookUrl: 'https://hooks.acme.example' }, 'token.webhookUrl'],
  ] as const)('%s: 400, naming the field, and nothing is stored', async (_, change, field) => {
    const { app, calls } = makeApp({ entries: ENTRIES });
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: { ...TOKEN, ...change },
    });
    expect([res.status, res.json.error?.code, res.json.error?.details?.field]).toEqual([
      400,
      'bad-input',
      field,
    ]);
    expect(calls.createApp).toBeUndefined();
  });

  test('a key under a reserved `kindgi.` name is refused, as any secret a registration names', async () => {
    const { app, calls } = makeApp({ entries: ENTRIES });
    const res = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: { ...TOKEN, apiKey: { envName: 'local', name: 'kindgi.telnyx' } },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('reserved-name-prefix');
    expect(calls.createApp).toBeUndefined();
  });

  test('a key a webhook endpoint already uses: 409 connection-key-in-use on a create and an update, naming it, and nothing is stored', async () => {
    const { app, calls } = makeApp({
      entries: ENTRIES,
      webhookEndpoints: [
        { endpointId: 'whe-1', secretRef: { envName: 'local', name: 'ACME_SHARED_KEY' } },
      ],
    });
    const shared = { ...TOKEN, apiKey: { envName: 'local', name: 'ACME_SHARED_KEY' } };
    const refused = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: shared,
    });
    expect([refused.status, refused.json.error?.code, refused.json.error?.details]).toEqual([
      409,
      'connection-key-in-use',
      { secret: 'ACME_SHARED_KEY', usedBy: [{ kind: 'webhook-endpoint', id: 'whe-1' }] },
    ]);
    expect(calls.createApp).toBeUndefined();

    // A key of its own goes ahead; moving it onto the shared one is refused the same way.
    const created = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: TOKEN,
    });
    expect(created.status).toBe(201);
    const moved = await call(app, 'admin', 'PATCH', `/v1/connection-apps/${created.json.appId}`, {
      token: shared,
    });
    expect([moved.status, moved.json.error?.code]).toEqual([409, 'connection-key-in-use']);
    expect(calls.updateApp).toBeUndefined();
  });

  /** A live registration put straight into the store, as one made earlier would be. */
  function seed(
    apps: Map<string, ConnectionAppRecord>,
    record: Omit<
      ConnectionAppRecord,
      'appId' | 'tenantId' | 'redirectUrl' | 'noticesUrl' | 'createdAt' | 'updatedAt'
    >,
  ): string {
    const appId = randomUUID();
    apps.set(appId, {
      appId,
      tenantId: tenantA,
      redirectUrl: 'https://kindgi.acme.example/console/connect/callback',
      noticesUrl: `https://kindgi.acme.example/v1/connection-notices/${tenantA}/${appId}`,
      createdAt: at,
      updatedAt: at,
      ...record,
    });
    return appId;
  }
  const CLIENT_ID = 'acme-client.apps.googleusercontent.com';
  const KEY_REFUSED = (appId: string) =>
    `\`ACME_TELNYX_KEY\` is the account key of connection app registration "${appId}": a connection app never names it, since that key reaches the whole provider account. Store the key under its own name (the same value is fine) and use that name`;

  test('a second texts registration on the same key, or an OAuth registration naming it: 400 connection-key-refused, naming the first, and nothing is stored', async () => {
    const { app, calls } = makeApp({ entries: ENTRIES });
    const first = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: TOKEN,
    });
    expect(first.status).toBe(201);
    const second = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: TOKEN,
    });
    expect([second.status, second.json.error]).toEqual([
      400,
      expect.objectContaining({
        code: 'connection-key-refused',
        message: KEY_REFUSED(first.json.appId),
        details: { secret: 'ACME_TELNYX_KEY', appId: first.json.appId },
      }),
    ]);
    const oauth = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'google',
      oauth2: { clientId: CLIENT_ID, clientSecret: TOKEN.apiKey },
    });
    expect([oauth.status, oauth.json.error?.code, oauth.json.error?.details]).toEqual([
      400,
      'connection-key-refused',
      { secret: 'ACME_TELNYX_KEY', appId: first.json.appId },
    ]);
    expect(calls.createApp).toHaveLength(1);
  });

  test("an update of the texts registration keeps its own key; another registration's moving onto it is refused", async () => {
    const { app, calls } = makeApp({ entries: ENTRIES });
    const first = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: TOKEN,
    });
    const kept = await call(app, 'admin', 'PATCH', `/v1/connection-apps/${first.json.appId}`, {
      label: 'Support line',
      token: TOKEN,
    });
    expect(kept.status, JSON.stringify(kept.json)).toBe(200);
    const other = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: { ...TOKEN, apiKey: { envName: 'local', name: 'ACME_SALES_TELNYX_KEY' } },
    });
    expect(other.status).toBe(201);
    const moved = await call(app, 'admin', 'PATCH', `/v1/connection-apps/${other.json.appId}`, {
      token: TOKEN,
    });
    expect([moved.status, moved.json.error?.code, moved.json.error?.details]).toEqual([
      400,
      'connection-key-refused',
      { secret: 'ACME_TELNYX_KEY', appId: first.json.appId },
    ]);
    expect(calls.updateApp).toHaveLength(1);
  });

  test('a key two registrations already hold, as two creates that raced leave it: an update of one keeping it is refused, naming the other', async () => {
    const { app, apps, calls } = makeApp({ entries: ENTRIES });
    const firstId = seed(apps, { app: 'texts', token: TOKEN });
    const secondId = seed(apps, { app: 'texts', token: TOKEN });
    const kept = await call(app, 'admin', 'PATCH', `/v1/connection-apps/${firstId}`, {
      label: 'Support line',
      token: TOKEN,
    });
    expect([kept.status, kept.json.error?.code, kept.json.error?.details]).toEqual([
      400,
      'connection-key-refused',
      { secret: 'ACME_TELNYX_KEY', appId: secondId },
    ]);
    expect(calls.updateApp).toBeUndefined();
  });

  test('a removed texts registration frees its key', async () => {
    const { app } = makeApp({ entries: ENTRIES });
    const first = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: TOKEN,
    });
    const removed = await call(app, 'admin', 'DELETE', `/v1/connection-apps/${first.json.appId}`);
    expect(removed.status).toBe(200);
    const again = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: TOKEN,
    });
    expect(again.status, JSON.stringify(again.json)).toBe(201);
  });

  test('a texts key another registration names as a secret: 409 connection-key-in-use, naming that registration', async () => {
    const { app, calls } = makeApp({ entries: ENTRIES });
    const oauth = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'google',
      oauth2: { clientId: CLIENT_ID, clientSecret: SECRET },
    });
    expect(oauth.status).toBe(201);
    const refused = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: { ...TOKEN, apiKey: SECRET },
    });
    expect([refused.status, refused.json.error?.code, refused.json.error?.details]).toEqual([
      409,
      'connection-key-in-use',
      { secret: SECRET.name, usedBy: [{ kind: 'connection-app', id: oauth.json.appId }] },
    ]);
    expect(calls.createApp).toHaveLength(1);
  });

  test('a clash past the first page of registrations is found, either way', async () => {
    const { app, apps, calls } = makeApp({ entries: ENTRIES });
    for (let i = 0; i < 100; i++) {
      seed(apps, {
        app: 'google',
        oauth2: {
          clientId: `acme-${i}.apps.googleusercontent.com`,
          clientSecret: { envName: 'local' as EnvName, name: `ACME_CLIENT_SECRET_${i}` },
        },
      });
    }
    const textsId = seed(apps, { app: 'texts', token: TOKEN });
    const oauthId = seed(apps, {
      app: 'google',
      oauth2: {
        clientId: CLIENT_ID,
        clientSecret: { envName: 'local' as EnvName, name: 'ACME_LAST_SECRET' },
      },
    });
    const named = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'google',
      oauth2: { clientId: CLIENT_ID, clientSecret: TOKEN.apiKey },
    });
    expect([named.status, named.json.error?.code, named.json.error?.details]).toEqual([
      400,
      'connection-key-refused',
      { secret: 'ACME_TELNYX_KEY', appId: textsId },
    ]);
    const used = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: { ...TOKEN, apiKey: { envName: 'local', name: 'ACME_LAST_SECRET' } },
    });
    expect([used.status, used.json.error?.code, used.json.error?.details?.usedBy]).toEqual([
      409,
      'connection-key-in-use',
      [{ kind: 'connection-app', id: oauthId }],
    ]);
    expect(calls.createApp).toBeUndefined();
    expect(calls.listApps?.some((i) => (i as { cursor?: string }).cursor === '100')).toBe(true);
  });

  test("a registration kept while its number's old inbound can't be put back still holds its key", async () => {
    const { app, connected, published } = makeApp({ entries: ENTRIES, tools: true });
    const created = await call(app, 'admin', 'POST', '/v1/connection-apps', {
      app: 'texts',
      token: TOKEN,
    });
    const appId = created.json.appId as string;
    connected({ kind: 'company' }, tenantA, {
      app: 'texts',
      appId,
      account: { id: 'num-15550000009', label: STUCK_NUMBER },
    });
    const removal = await call(
      app,
      'admin',
      'DELETE',
      `/v1/connection-apps/${appId}?withConnections=true`,
    );
    expect([removal.status, removal.json.error?.code]).toEqual([502, 'inbound-restore-failed']);
    const tool = await call(app, 'admin', 'POST', '/v1/tools', {
      id: 'acme.sms',
      version: '1.0.0',
      description: 'Send a text.',
      input: { type: 'object' },
      output: { type: 'object' },
      needsSpec: { secrets: { ACME_TELNYX_KEY: { type: 'string' } } },
      projectId: randomUUID(),
    });
    expect([tool.status, tool.json.error?.code, tool.json.error?.details]).toEqual([
      400,
      'connection-key-refused',
      { secret: 'ACME_TELNYX_KEY', appId },
    ]);
    expect(published).toEqual([]);
  });

  test('a connect names the number: 201, already connected, with its connection, and the usual link and expiry', async () => {
    const { app, calls } = makeApp({ entries: ENTRIES });
    const res = await call(app, 'admin', 'POST', '/v1/connections', {
      app: 'texts',
      for: 'company',
      permissions: ['texts.reply'],
      number: NUMBER,
      replaceInbound: true,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json).toMatchObject({
      app: 'texts',
      owner: { kind: 'company' },
      permissions: ['texts.reply'],
      state: 'connected',
      connectionId: expect.any(String),
    });
    expect(res.json.connectUrl).toMatch(new RegExp(`/console/connect/${res.json.requestId}$`));
    expect(Date.parse(res.json.expiresAt)).toBeGreaterThan(Date.parse(res.json.createdAt));
    expect(validateAgainst('ConnectRequest', res.json)).toEqual([]);
    expect(calls.createRequest?.[0]).toMatchObject({ number: NUMBER, replaceInbound: true });
    const connection = await call(app, 'admin', 'GET', `/v1/connections/${res.json.connectionId}`);
    expect(connection.json.account).toEqual({ id: 'num-15551234567', label: NUMBER });

    // Without replaceInbound, the binding gets none.
    await call(app, 'admin', 'POST', '/v1/connections', {
      app: 'texts',
      for: 'company',
      permissions: ['texts.send'],
      number: '+15557654321',
    });
    expect(calls.createRequest?.[1]).not.toHaveProperty('replaceInbound');
  });

  test.each([
    ['a number without its +', { number: '15551234567' }, 'number'],
    ['a number whose country code starts with 0', { number: '+05551234567' }, 'number'],
    ['a number too long', { number: '+1555123456789012' }, 'number'],
    ['a number that is no string', { number: 15551234567 }, 'number'],
    ['replaceInbound false', { number: NUMBER, replaceInbound: false }, 'replaceInbound'],
    ['replaceInbound as a word', { number: NUMBER, replaceInbound: 'yes' }, 'replaceInbound'],
  ] as const)(
    '%s: 400, naming the field, and nothing is asked of the binding',
    async (_, more, field) => {
      const { app, calls } = makeApp({ entries: ENTRIES });
      const res = await call(app, 'admin', 'POST', '/v1/connections', {
        app: 'texts',
        for: 'company',
        permissions: ['texts.reply'],
        ...more,
      });
      expect([res.status, res.json.error?.code, res.json.error?.details?.field]).toEqual([
        400,
        'bad-input',
        field,
      ]);
      expect(calls.createRequest).toBeUndefined();
    },
  );

  test.each([
    ['+15550000001', 409, 'inbound-in-use', { host: 'hooks.acme.example' }],
    ['+15550000002', 409, 'inbound-in-use', { profile: 'Acme support' }],
    [
      '+15550000003',
      409,
      'number-in-use',
      { appId: '7d0e2c55-2222-4b3c-9d4e-000000000002', envName: 'prod' },
    ],
    ['+15550000004', 502, 'connection-app-refused', {}],
  ] as const)(
    "%s: the binding's refusal, %i %s, with its details",
    async (number, status, code, details) => {
      const { app } = makeApp({ entries: ENTRIES });
      const res = await call(app, 'admin', 'POST', '/v1/connections', {
        app: 'texts',
        for: 'company',
        permissions: ['texts.reply'],
        number,
      });
      expect([res.status, res.json.error?.code]).toEqual([status, code]);
      expect(res.json.error.details ?? {}).toEqual(details);
      expect(res.json.error.message).toBe(NUMBER_REFUSALS[number]?.message);
    },
  );

  test('a disconnect passes skipInboundRestore on only for `=true`', async () => {
    const { app, calls, connected } = makeApp({ entries: ENTRIES });
    for (const query of [
      '?skipInboundRestore=true',
      '',
      '?skipInboundRestore=false',
      '?skipInboundRestore=1',
    ]) {
      const number = connected({ kind: 'company' }, tenantA, {
        app: 'texts',
        account: { id: 'num-15551234567', label: NUMBER },
      });
      const res = await call(
        app,
        'admin',
        'DELETE',
        `/v1/connections/${number.connectionId}${query}`,
      );
      expect(res.status, query).toBe(200);
    }
    expect(
      calls.disconnect?.map((input) => (input as { skipInboundRestore?: true }).skipInboundRestore),
    ).toEqual([true, undefined, undefined, undefined]);
    expect(calls.disconnect?.[1]).not.toHaveProperty('skipInboundRestore');
  });

  test("a number whose old inbound can't be put back: 502 inbound-restore-failed, it stays removing, and the skip removes it", async () => {
    const { app, connected } = makeApp({ entries: ENTRIES });
    const stuck = connected({ kind: 'company' }, tenantA, {
      app: 'texts',
      account: { id: 'num-15550000009', label: STUCK_NUMBER },
    });
    const path = `/v1/connections/${stuck.connectionId}`;
    const failed = await call(app, 'admin', 'DELETE', path);
    expect([failed.status, failed.json.error?.code, failed.json.error?.details]).toEqual([
      502,
      'inbound-restore-failed',
      { profile: 'Acme support' },
    ]);
    expect((await call(app, 'admin', 'GET', path)).json.state).toBe('removing');
    const skipped = await call(app, 'admin', 'DELETE', `${path}?skipInboundRestore=true`);
    expect(skipped.status).toBe(200);
    expect(skipped.json).toMatchObject({ state: 'removed', withdrawn: 'at-app' });
  });

  test("a number's connection shows when a text last proved itself, and this month's counts; another app's has neither", async () => {
    const { app, connected } = makeApp({ entries: ENTRIES });
    const number = connected({ kind: 'company' }, tenantA, {
      app: 'texts',
      account: { id: 'num-15551234567', label: NUMBER },
      permissions: ['texts.reply'],
      lastProvenInboundAt: at,
      textsThisMonth: { received: 12, sent: 9, unanswered: 3 },
    });
    const res = await call(app, 'admin', 'GET', `/v1/connections/${number.connectionId}`);
    expect(res.json).toMatchObject({
      lastProvenInboundAt: at,
      textsThisMonth: { received: 12, sent: 9, unanswered: 3 },
    });
    expect(validateAgainst('Connection', res.json)).toEqual([]);
    const mail = connected({ kind: 'company' });
    const other = await call(app, 'admin', 'GET', `/v1/connections/${mail.connectionId}`);
    expect(other.json).not.toHaveProperty('lastProvenInboundAt');
    expect(other.json).not.toHaveProperty('textsThisMonth');
  });

  test('a credential-refused connection says so, and fits the schema', async () => {
    const { app, connected } = makeApp({ entries: ENTRIES });
    const number = connected({ kind: 'company' }, tenantA, {
      app: 'texts',
      account: { id: 'num-15551234567', label: NUMBER },
      state: 'needs-reconnecting',
      stateReason: 'credential-refused',
    });
    const res = await call(app, 'admin', 'GET', `/v1/connections/${number.connectionId}`);
    expect(res.json).toMatchObject({
      state: 'needs-reconnecting',
      stateReason: 'credential-refused',
    });
    expect(validateAgainst('Connection', res.json)).toEqual([]);
  });
});

describe('mounting', () => {
  test('connections need the env the server serves', () => {
    const memory = memoryBinding();
    expect(() =>
      createApp({
        ...createStubAppBindings(),
        resolveToken,
        runHandler,
        connections: memory.binding,
      }),
    ).toThrow(/`connections` needs `envName`/);
  });
});
