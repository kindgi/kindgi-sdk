// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A key or session limited to a project, and the items it changes by
 * their id: an agent, a flow, a tool, a guardrail, a block or a test set
 * (unregistering or reinstating a version, an agent's owner, a pin, an
 * agent's test set's cases), a corrector group, an event trigger and an
 * MCP endpoint. Without an authorization store, a change that reaches
 * another project is refused, `403 key-project-mismatch`, before anything
 * is written, as a store refuses it (`permission-denied`).
 *
 * What a change reaches is what a store asks of it. For an item more than
 * one project serves: every project the item runs in, or the version
 * does, or the one project a pin or a case is in. Else the item's own
 * project. The refusal names the first of those that isn't the key's.
 *
 * An item in the key's project, one whose record names no project, an id
 * the registry doesn't know, and a key limited to no project are not
 * refused, and reads never are. A lookup that fails is the error it is.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type {
  ConversationId,
  OrgId,
  ProjectId,
  RunId,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import { OPERATIONS, createApp } from '../src/index.js';
import type {
  AgentPinBindings,
  CorrectionRegistryBinding,
  CreateAppInput,
  ItemProjectsBinding,
  MCPEndpointRegistryBinding,
  OrderItemKind,
  PinnedVersionBinding,
  RunHandlerBinding,
  TokenResolver,
  TriggerRegistryBinding,
} from '../src/index.js';
import { LIMITED_ITEM_PROJECT } from '../src/openapi/operations.js';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';
import { noLatest } from './support/latest.js';
import { type ItemRow, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const USER = randomUUID() as UserId;
/** The project the key and the session are limited to. */
const P1 = randomUUID() as ProjectId;
/** Other projects of the workspace. */
const P2 = randomUUID() as ProjectId;
const P3 = randomUUID() as ProjectId;
const ORG = randomUUID() as OrgId;
const NOW = '2026-10-01T00:00:00.000Z' as Timestamp;
const LIMITED = 'kgi_ak_test_limited_to_p1';
const SESSION = 'kgi_ak_test_session_limited_to_p1';
const UNLIMITED = 'kgi_ak_test_not_limited';

const resolveToken: TokenResolver = async (token) => {
  if (token === LIMITED) return { tenantId, userId: USER, tokenProjectId: P1 };
  if (token === SESSION) {
    return { tenantId, userId: USER, tokenProjectId: P1, sessionId: 'ses-acme' as never };
  }
  return token === UNLIMITED ? { tenantId, userId: USER } : null;
};

/** In another project alone. */
const AWAY = 'acme.away';
/** In the key's project alone. */
const HOME = 'acme.home';
/** The key's project's, and served in P2 too: `1.0.0` runs in both, `1.1.0` in the key's alone. */
const SHARED = 'acme.shared';
/** The key's project's, then served in P3 and in P2, in that order. */
const SPREAD = 'acme.spread';
/** An item whose record names no project, as `kindgi dev` reads a pack's. */
const LOOSE = 'acme.loose';
/** No such item. */
const NOWHERE = 'acme.nowhere';

const KINDS = [
  {
    kind: 'agent',
    base: '/v1/agents',
    registry: 'agentRegistry',
    idKey: 'agentId',
    word: 'the agent',
  },
  { kind: 'flow', base: '/v1/flows', registry: 'flowRegistry', idKey: 'flowId', word: 'the flow' },
  { kind: 'tool', base: '/v1/tools', registry: 'toolRegistry', idKey: 'toolId', word: 'the tool' },
  {
    kind: 'test_set',
    base: '/v1/test-sets',
    registry: 'testSetRegistry',
    idKey: 'testSetId',
    word: 'the test set',
  },
  {
    kind: 'block',
    base: '/v1/blocks',
    registry: 'blockRegistry',
    idKey: 'blockId',
    word: 'the block',
  },
] as const;

const GUARDRAIL = {
  kind: 'guardrail',
  base: '/v1/guardrails',
  registry: 'guardrailRegistry',
  idKey: 'guardrailId',
  word: 'the guardrail',
} as const;

/** What the item-projects binding says of each item. */
function rows(): ItemRow[] {
  return [...KINDS.map((k) => k.kind), GUARDRAIL.kind].flatMap((kind): ItemRow[] => {
    const versions = (...vs: (readonly [string, readonly ProjectId[]])[]) =>
      kind === 'guardrail'
        ? {}
        : { versions: vs.map(([version, projects]) => ({ version, projects })) };
    return [
      { kind: kind as OrderItemKind, id: AWAY, projects: [P2], ...versions(['1.0.0', [P2]]) },
      { kind: kind as OrderItemKind, id: HOME, projects: [P1], ...versions(['1.0.0', [P1]]) },
      {
        kind: kind as OrderItemKind,
        id: SHARED,
        projects: [P1, P2],
        ...versions(['1.0.0', [P1, P2]], ['1.1.0', [P1]]),
      },
      {
        kind: kind as OrderItemKind,
        id: SPREAD,
        projects: [P1, P3, P2],
        ...versions(['1.0.0', [P1, P3, P2]]),
      },
    ];
  });
}

const rec = (id: string, version: string, projectId: ProjectId | undefined) => ({
  id,
  version,
  ...(projectId !== undefined && { projectId }),
  tenantId,
  name: id,
  publishedAt: NOW,
});

/**
 * A registry of one kind: the versions it reads, each recording its own
 * project, and every other method (a change) recorded in `changed` before
 * it fails, so a test sees the request got past the checks.
 */
function registry(idKey: string, changed: string[]) {
  const records = [
    rec(AWAY, '1.0.0', P2),
    rec(HOME, '1.0.0', P1),
    rec(SHARED, '1.0.0', P1),
    rec(SHARED, '1.1.0', P1),
    rec(SPREAD, '1.0.0', P1),
    rec(LOOSE, '1.0.0', undefined),
  ];
  const versionsOf = (id: string) => records.filter((r) => r.id === id);
  const reads: Record<string, (input: Record<string, string>) => Promise<unknown>> = {
    get: async (input) => versionsOf(input[idKey] ?? '').at(-1) ?? null,
    getVersion: async (input) =>
      versionsOf(input[idKey] ?? '').find((r) => r.version === input.version) ?? null,
    headExists: async (input) => versionsOf(input[idKey] ?? '').length > 0,
    listVersions: async (input) => ({
      data: versionsOf(input[idKey] ?? '')
        .slice()
        .reverse(),
    }),
  };
  return recordingRest(reads, changed);
}

/**
 * `reads` as they are; any other method recorded in `changed`, then
 * failing. `absent`: optional methods the binding doesn't have.
 */
function recordingRest<T extends object>(
  reads: T,
  changed: string[],
  absent: readonly string[] = [],
): T {
  return new Proxy(reads, {
    get(target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name in target) return (target as Record<string, unknown>)[name];
      if (name === 'readOnly' || absent.includes(name)) return undefined;
      return async () => {
        changed.push(name);
        throw new Error(`test: ${name} reached`);
      };
    },
  });
}

/** Agent pins: the pin and the unpin recorded. */
function agentPins(changed: string[]): AgentPinBindings {
  return {
    pinned: { resolve: async () => null, list: async () => [] },
    latest: noLatest,
    changes: recordingRest(
      { list: async () => ({ data: [] }), get: async () => null },
      changed,
    ) as unknown as AgentPinBindings['changes'],
  };
}

/** A flow's and a tool's pins: the pin and the unpin recorded. */
function pinnedVersions(changed: string[]): PinnedVersionBinding {
  return recordingRest(
    {
      resolve: async () => null,
      list: async () => ({ data: [], hasMore: false }),
      history: async () => ({ data: [], hasMore: false }),
    },
    changed,
  ) as unknown as PinnedVersionBinding;
}

const project = (projectId: ProjectId) => ({ kind: 'project' as const, projectId });

/** Corrector groups and test-set cases, by their ids; every change recorded. */
function corrections(changed: string[]): CorrectionRegistryBinding {
  const groups: Record<string, { kind: 'tenant' } | ReturnType<typeof project>> = {
    'grp-away': project(P2),
    'grp-home': project(P1),
    'grp-tenant': { kind: 'tenant' },
  };
  const cases: Record<string, { agentId: string; projectId: ProjectId }> = {
    'case-away': { agentId: AWAY, projectId: P2 },
    'case-home': { agentId: HOME, projectId: P1 },
    'case-shared-p2': { agentId: SHARED, projectId: P2 },
  };
  return recordingRest(
    {
      getGroup: async ({ correctorGroupId }: { correctorGroupId: string }) => {
        const scope = groups[correctorGroupId];
        return scope === undefined
          ? null
          : { id: correctorGroupId, tenantId, scope, name: correctorGroupId, weight: 1 };
      },
      getCase: async ({ agentId, caseId }: { agentId: string; caseId: string }) => {
        const found = cases[caseId];
        return found === undefined || found.agentId !== agentId
          ? null
          : { id: caseId, agentId, projectId: found.projectId };
      },
    },
    changed,
  ) as unknown as CorrectionRegistryBinding;
}

/** A completed run of `agentId` in `projectId`, for a case added from it. */
function run(agentId: string, projectId: ProjectId): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId,
    flowId: 'acme.match',
    flowVersion: '1.0.0',
    status: 'completed',
    input: { query: 'acme' },
    output: { answer: 'Refunded.' },
    dryRun: false,
    createdAt: NOW,
    updatedAt: NOW,
    agent: { id: agentId, version: '1.0.0', conversationId: randomUUID() as ConversationId },
  };
}

const RUNS = {
  away: run(AWAY, P2),
  home: run(HOME, P1),
  sharedInP2: run(SHARED, P2),
  sharedInP1: run(SHARED, P1),
};

const MCP_SCOPES: Record<string, Scope> = {
  'mcp-away': { kind: 'project', tenantId, projectId: P2 },
  'mcp-home': { kind: 'project', tenantId, projectId: P1 },
  'mcp-tenant': { kind: 'tenant', tenantId },
  'mcp-org': { kind: 'org', tenantId, orgId: ORG },
};

/** MCP endpoints with their scopes: `scopeOf` as asked, or none, or one that fails. */
function mcpEndpoints(
  changed: string[],
  scopeOf: 'wired' | 'none' | 'fails',
): MCPEndpointRegistryBinding {
  const endpoint = (endpointId: string) => ({
    id: endpointId,
    name: endpointId,
    transport: { kind: 'streamable-http', url: 'https://mcp.acme.example/mcp' },
  });
  return recordingRest(
    {
      get: async ({ endpointId }: { endpointId: string }) =>
        endpointId in MCP_SCOPES ? endpoint(endpointId) : null,
      list: async () => ({ data: [], hasMore: false }),
      ...(scopeOf === 'wired' && {
        scopeOf: async ({ endpointId }: { endpointId: string }) => MCP_SCOPES[endpointId] ?? null,
      }),
      ...(scopeOf === 'fails' && {
        scopeOf: async () => {
          throw new Error('test: the scope lookup failed');
        },
      }),
    },
    changed,
    ['scopeOf'],
  ) as unknown as MCPEndpointRegistryBinding;
}

/** A store that grants everything: what it refuses, the key's limit refuses. */
const granted = (action: Action, r: ResourceRef): Decision => ({
  allowed: true,
  reason: 'test: granted',
  evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
});

/** What the store places in P1. A key limited to P1 reaches nothing else that isn't a project. */
const IN_P1 = new Set([
  ...[...KINDS.map((k) => k.kind), GUARDRAIL.kind].map((kind) => `${kind}:${HOME}`),
  'mcp_endpoint:mcp-home',
]);

type Mode = 'served' | 'recorded' | 'store';

/**
 * The app with every kind, and no store. `served`: the host wires which
 * projects serve each item, as the runtime does; `recorded`: it doesn't,
 * and each item's record names its project. `store`: with a store, and
 * without the item-projects binding.
 */
function harness(
  mode: Mode,
  opts: {
    readonly scopeOf?: 'wired' | 'none' | 'fails';
    readonly items?: ItemProjectsBinding;
  } = {},
) {
  const changed: string[] = [];
  const registries = Object.fromEntries(
    [...KINDS, GUARDRAIL].map((k) => [k.registry, registry(k.idKey, changed)]),
  );
  const stubs = createStubAppBindings();
  const runBinding = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) =>
      Object.values(RUNS).find((r) => r.runId === id) ?? null,
  } as unknown as RunBinding;
  const triggers = recordingWrites(
    createInMemoryTriggerRegistry({ defaultProjectId: P1 }),
    changed,
  );
  const app = createApp({
    ...stubs,
    ...registries,
    kernelBinding: { ...stubs.kernelBinding, run: runBinding },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    agentPins: agentPins(changed),
    pinnedVersions: pinnedVersions(changed),
    correctionRegistry: corrections(changed),
    triggerRegistry: triggers,
    mcpEndpointRegistry: mcpEndpoints(changed, opts.scopeOf ?? 'wired'),
    ...(mode === 'served' && { itemProjects: opts.items ?? itemProjects(rows()) }),
    ...(mode === 'store' && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          inProject: async (_p, r, projectId) => projectId === P1 && IN_P1.has(`${r.type}:${r.id}`),
          check: async (_p, action, r) => granted(action, r),
          checkBatch: async (_p, action, rs) => rs.map((r) => granted(action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  } as unknown as CreateAppInput);
  const send = async (token: string, method: string, path: string, body?: unknown) => {
    changed.length = 0;
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: Body = {};
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as Body) : {};
    } catch {
      // Not JSON: no error code to read.
    }
    return { status: res.status, body: parsed, changed: [...changed] };
  };
  return { send };
}

type Harness = ReturnType<typeof harness>;

type Body = {
  triggerId?: string;
  error?: { code: string; message?: string; details?: Record<string, unknown> };
};

const WRITE_CALL = /^(fire|pause|register|resume|set|unregister|update)/;

/** The trigger registry, its write-named calls recorded in `changed`. */
function recordingWrites(registry: TriggerRegistryBinding, changed: string[]) {
  return new Proxy(registry, {
    get(t, key) {
      const value: unknown = Reflect.get(t, key, t);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (typeof key === 'string' && WRITE_CALL.test(key)) changed.push(key);
        return value.apply(t, args);
      };
    },
  });
}

const EVENT = { flowVersion: '1.0.0', config: { eventKind: 'acme.ticket.opened' } };

/** An event trigger of `flowId`, registered by a key limited to no project. */
async function eventTrigger(h: Harness, flowId: string): Promise<string> {
  const res = await h.send(UNLIMITED, 'POST', '/v1/event-triggers', { flowId, ...EVENT });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.triggerId as string;
}

/** Which item a row changes: another project's, or the key's own. */
type Side = 'away' | 'home';

type Row = {
  readonly label: string;
  /** The operation, as `METHOD /openapi/path`. */
  readonly op: string;
  readonly method: string;
  /** What the refusal names. */
  readonly word: string;
  /** The request on the side's item. */
  readonly to: (h: Harness, side: Side) => Promise<{ path: string; body?: unknown }>;
};

const ITEM = { away: AWAY, home: HOME } as const;
const pinBody = { version: '1.0.0', scope: project(P1) };

/** One row per change by id that a store holds and, until now, nothing held without one. */
const HELD: readonly Row[] = [
  ...KINDS.flatMap((k): Row[] =>
    (['unregister', 'reinstate'] as const).map((verb) => ({
      label: `${k.kind} version ${verb}`,
      op: `POST ${k.base}/{${k.idKey}}/versions/{version}/${verb}`,
      method: 'POST',
      word: k.word,
      to: async (_h, side) => ({ path: `${k.base}/${ITEM[side]}/versions/1.0.0/${verb}` }),
    })),
  ),
  {
    label: 'agent owner',
    op: 'PUT /v1/agents/{agentId}/owner',
    method: 'PUT',
    word: 'the agent',
    to: async (_h, side) => ({ path: `/v1/agents/${ITEM[side]}/owner`, body: {} }),
  },
  {
    label: 'guardrail unregister',
    op: 'POST /v1/guardrails/{guardrailId}/unregister',
    method: 'POST',
    word: 'the guardrail',
    to: async (_h, side) => ({ path: `/v1/guardrails/${ITEM[side]}/unregister` }),
  },
  ...(['agent', 'flow', 'tool'] as const).flatMap((kind): Row[] => {
    const k = KINDS.find((x) => x.kind === kind) as (typeof KINDS)[number];
    return (['pin', 'unpin'] as const).map((verb) => ({
      label: `${kind} ${verb} in the key's project`,
      op: `POST ${k.base}/{${k.idKey}}/pinned/${verb}`,
      method: 'POST',
      word: k.word,
      to: async (_h, side) => ({
        path: `${k.base}/${ITEM[side]}/pinned/${verb}`,
        body: verb === 'pin' ? pinBody : { scope: project(P1) },
      }),
    }));
  }),
  {
    label: "agent test set: a case added from the agent's run",
    op: 'POST /v1/agents/{agentId}/test-set/cases',
    method: 'POST',
    word: 'the agent',
    to: async (_h, side) => ({
      path: `/v1/agents/${ITEM[side]}/test-set/cases`,
      body: { runId: RUNS[side].runId, answer: 'right' },
    }),
  },
  {
    label: "agent test set: a case's retire",
    op: 'POST /v1/agents/{agentId}/test-set/cases/{caseId}/retire',
    method: 'POST',
    word: 'the agent',
    to: async (_h, side) => ({
      path: `/v1/agents/${ITEM[side]}/test-set/cases/case-${side}/retire`,
      body: { reason: 'It no longer applies.' },
    }),
  },
  {
    label: 'corrector group update',
    op: 'PATCH /v1/corrector-groups/{correctorGroupId}',
    method: 'PATCH',
    word: 'the corrector group',
    to: async (_h, side) => ({ path: `/v1/corrector-groups/grp-${side}`, body: { weight: 2 } }),
  },
  {
    label: 'corrector group unregister',
    op: 'POST /v1/corrector-groups/{correctorGroupId}/unregister',
    method: 'POST',
    word: 'the corrector group',
    to: async (_h, side) => ({ path: `/v1/corrector-groups/grp-${side}/unregister`, body: {} }),
  },
  {
    label: 'event trigger register',
    op: 'POST /v1/event-triggers',
    method: 'POST',
    word: "the trigger's flow",
    to: async (_h, side) => ({
      path: '/v1/event-triggers',
      body: { flowId: ITEM[side], ...EVENT },
    }),
  },
  ...(
    [
      ['PATCH', '', { label: 'renamed' }],
      ['POST', '/pause', undefined],
      ['POST', '/resume', undefined],
      ['POST', '/unregister', undefined],
    ] as const
  ).map(
    ([method, tail, body]): Row => ({
      label: `event trigger ${tail === '' ? 'update' : tail.slice(1)}`,
      op: `${method} /v1/event-triggers/{triggerId}${tail}`,
      method,
      word: "the trigger's flow",
      to: async (h, side) => ({
        path: `/v1/event-triggers/${await eventTrigger(h, ITEM[side])}${tail}`,
        ...(body !== undefined && { body }),
      }),
    }),
  ),
  {
    label: 'MCP endpoint unregister',
    op: 'POST /v1/mcp/endpoints/{endpointId}/unregister',
    method: 'POST',
    word: 'the MCP endpoint',
    to: async (_h, side) => ({ path: `/v1/mcp/endpoints/mcp-${side}/unregister`, body: {} }),
  },
  {
    label: 'MCP endpoint prompt',
    op: 'POST /v1/mcp/endpoints/{endpointId}/prompts/{name}',
    method: 'POST',
    word: 'the MCP endpoint',
    to: async (_h, side) => ({
      path: `/v1/mcp/endpoints/mcp-${side}/prompts/greet`,
      body: { arguments: {} },
    }),
  },
];

/** `row` on its side's item, sent by `token`. */
async function sendRow(h: Harness, token: string, r: Row, side: Side) {
  const { path, body } = await r.to(h, side);
  return h.send(token, r.method, path, body);
}

const served = harness('served');
const recorded = harness('recorded');
const withStore = harness('store');

const refusedWith = (
  res: Awaited<ReturnType<Harness['send']>>,
  message: string,
  projectId: string | undefined,
) => {
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(res.body.error).toMatchObject({
    code: 'key-project-mismatch',
    message,
    details: { keyProjectId: P1, ...(projectId !== undefined && { projectId }) },
  });
  if (projectId === undefined) expect(res.body.error?.details).not.toHaveProperty('projectId');
  expect(res.changed).toEqual([]);
};

// Every operation, unserved ones too: event triggers aren't in the generated document yet.
test('every operation whose 403 names this refusal has a row, and no other', () => {
  const documented = OPERATIONS.filter((o) =>
    JSON.stringify(o.responses['403'] ?? '').includes(LIMITED_ITEM_PROJECT),
  ).map((o) => `${o.method.toUpperCase()} ${o.openapiPath}`);
  expect(HELD.map((r) => r.op).sort()).toEqual(documented.sort());
});

describe.each([
  ['the host says which projects serve each item', served],
  ['each item records its own project', recorded],
] as const)("another project's item, with no store, where %s", (_where, h) => {
  test.each(HELD)('$label: 403 key-project-mismatch, nothing written', async (r) => {
    const res = await sendRow(h, LIMITED, r, 'away');
    refusedWith(res, `This API key is limited to project ${P1}; ${r.word} is in project ${P2}`, P2);
  });

  test.each(HELD)("$label, on the key project's own item: not refused", async (r) => {
    const res = await sendRow(h, LIMITED, r, 'home');
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });

  test.each(HELD)('$label, by a key limited to no project: not refused', async (r) => {
    const res = await sendRow(h, UNLIMITED, r, 'away');
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });

  test('a session limited to a project is held the same way', async () => {
    for (const r of HELD.filter((x) =>
      /^(agent version unregister|corrector group update|MCP endpoint unregister|event trigger pause)$/.test(
        x.label,
      ),
    )) {
      const res = await sendRow(h, SESSION, r, 'away');
      refusedWith(
        res,
        `This session is limited to project ${P1}; ${r.word} is in project ${P2}`,
        P2,
      );
    }
  });

  test.each([...KINDS, GUARDRAIL])(
    '$kind: an id the registry does not know is not refused',
    async (k) => {
      const path =
        k.kind === 'guardrail'
          ? `${k.base}/${NOWHERE}/unregister`
          : `${k.base}/${NOWHERE}/versions/1.0.0/unregister`;
      const res = await h.send(LIMITED, 'POST', path);
      expect(res.body.error?.code).not.toBe('key-project-mismatch');
    },
  );

  test("reading another project's item by its id is not refused", async () => {
    for (const path of [
      `/v1/agents/${AWAY}`,
      `/v1/flows/${AWAY}/versions`,
      `/v1/guardrails/${AWAY}`,
      '/v1/corrector-groups/grp-away',
      '/v1/mcp/endpoints/mcp-away',
    ]) {
      const res = await h.send(LIMITED, 'GET', path);
      expect(res.body.error?.code, path).not.toBe('key-project-mismatch');
    }
  });
});

describe('a change that is not refused reaches the registry, so the rows above see one', () => {
  test.each([
    ['the agent', `/v1/agents/${HOME}/versions/1.0.0/unregister`],
    ['the guardrail', `/v1/guardrails/${HOME}/unregister`],
    ['the MCP endpoint', '/v1/mcp/endpoints/mcp-home/unregister'],
  ])('%s, in the key project', async (_what, path) => {
    const res = await served.send(LIMITED, 'POST', path, {});
    expect(res.changed).toContain('unregister');
  });

  test('an item whose record names no project (`kindgi dev`)', async () => {
    for (const k of KINDS) {
      const res = await recorded.send(
        LIMITED,
        'POST',
        `${k.base}/${LOOSE}/versions/1.0.0/unregister`,
      );
      expect(res.body.error?.code, k.kind).not.toBe('key-project-mismatch');
      expect(res.changed, k.kind).toContain('unregister');
    }
  });

  test('an id the registry does not know', async () => {
    const res = await served.send(
      LIMITED,
      'POST',
      `/v1/agents/${NOWHERE}/versions/1.0.0/unregister`,
    );
    expect(res.changed).toContain('unregister');
  });
});

describe('an item more than one project serves, with no store: what a store asks', () => {
  test.each(KINDS)(
    '$kind: a version that runs in the key project alone is not refused',
    async (k) => {
      const res = await served.send(
        LIMITED,
        'POST',
        `${k.base}/${SHARED}/versions/1.1.0/unregister`,
      );
      expect(res.body.error?.code).not.toBe('key-project-mismatch');
      expect(res.changed).toContain('unregister');
    },
  );

  test.each(KINDS)('$kind: a version that runs in another project too is refused', async (k) => {
    const res = await served.send(LIMITED, 'POST', `${k.base}/${SHARED}/versions/1.0.0/unregister`);
    refusedWith(
      res,
      `This API key is limited to project ${P1}; ${k.word} runs in project ${P2} too`,
      P2,
    );
  });

  test('a guardrail served in another project too is refused', async () => {
    const res = await served.send(LIMITED, 'POST', `/v1/guardrails/${SHARED}/unregister`);
    refusedWith(
      res,
      `This API key is limited to project ${P1}; the guardrail runs in project ${P2} too`,
      P2,
    );
  });

  test("the refusal names the first of its projects that is not the key's", async () => {
    const owner = await served.send(LIMITED, 'PUT', `/v1/agents/${SPREAD}/owner`, {});
    refusedWith(
      owner,
      `This API key is limited to project ${P1}; the agent runs in project ${P3} too`,
      P3,
    );
    const version = await served.send(
      LIMITED,
      'POST',
      `/v1/tools/${SPREAD}/versions/1.0.0/unregister`,
    );
    refusedWith(
      version,
      `This API key is limited to project ${P1}; the tool runs in project ${P3} too`,
      P3,
    );
  });

  test.each(['agent', 'flow', 'tool'] as const)(
    '%s: a pin in the key project is not refused',
    async (kind) => {
      const k = KINDS.find((x) => x.kind === kind) as (typeof KINDS)[number];
      const res = await served.send(LIMITED, 'POST', `${k.base}/${SHARED}/pinned/pin`, pinBody);
      expect(res.body.error?.code).not.toBe('key-project-mismatch');
    },
  );

  test("a case in another project is refused for that project, the agent's own being the key's", async () => {
    const res = await served.send(LIMITED, 'POST', `/v1/agents/${SHARED}/test-set/cases`, {
      runId: RUNS.sharedInP2.runId,
      answer: 'right',
    });
    refusedWith(res, `This API key is limited to project ${P1}; the case is in project ${P2}`, P2);
    const retire = await served.send(
      LIMITED,
      'POST',
      `/v1/agents/${SHARED}/test-set/cases/case-shared-p2/retire`,
      { reason: 'It no longer applies.' },
    );
    refusedWith(
      retire,
      `This API key is limited to project ${P1}; the case is in project ${P2}`,
      P2,
    );
  });

  test('a case in the key project is not refused', async () => {
    const res = await served.send(LIMITED, 'POST', `/v1/agents/${SHARED}/test-set/cases`, {
      runId: RUNS.sharedInP1.runId,
      answer: 'right',
    });
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });

  test("an event trigger of a flow whose own project is the key's is not refused", async () => {
    const res = await served.send(LIMITED, 'POST', '/v1/event-triggers', {
      flowId: SHARED,
      ...EVENT,
    });
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
    expect(res.changed).toContain('register');
  });
});

describe("an item of the workspace's or an org's, with no store", () => {
  test('a workspace corrector group is refused', async () => {
    for (const [method, tail, body] of [
      ['PATCH', '', { weight: 2 }],
      ['POST', '/unregister', {}],
    ] as const) {
      const res = await served.send(
        LIMITED,
        method,
        `/v1/corrector-groups/grp-tenant${tail}`,
        body,
      );
      refusedWith(
        res,
        `This API key is limited to project ${P1}, and this request changes the workspace`,
        undefined,
      );
    }
  });

  test("a workspace's or an org's MCP endpoint is refused its unregister", async () => {
    const tenant = await served.send(
      LIMITED,
      'POST',
      '/v1/mcp/endpoints/mcp-tenant/unregister',
      {},
    );
    refusedWith(
      tenant,
      `This API key is limited to project ${P1}, and this request changes the workspace`,
      undefined,
    );
    const org = await served.send(LIMITED, 'POST', '/v1/mcp/endpoints/mcp-org/unregister', {});
    refusedWith(
      org,
      `This API key is limited to project ${P1}, and this request changes org ${ORG}`,
      undefined,
    );
  });

  test("a workspace's or an org's MCP endpoint renders a prompt: a project's runs reach it", async () => {
    for (const id of ['mcp-tenant', 'mcp-org']) {
      const res = await served.send(LIMITED, 'POST', `/v1/mcp/endpoints/${id}/prompts/greet`, {
        arguments: {},
      });
      expect(res.body.error?.code, id).not.toBe('key-project-mismatch');
    }
  });
});

describe('where the host gives no scope or the lookup fails', () => {
  test('an MCP endpoint the registry does not know is not refused', async () => {
    const res = await served.send(
      LIMITED,
      'POST',
      `/v1/mcp/endpoints/${randomUUID()}/unregister`,
      {},
    );
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });

  test('an MCP registry that gives no scopes: not refused, as before', async () => {
    const h = harness('served', { scopeOf: 'none' });
    const res = await h.send(LIMITED, 'POST', '/v1/mcp/endpoints/mcp-away/unregister', {});
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
    expect(res.changed).toContain('unregister');
  });

  test("an MCP endpoint's scope lookup that fails is the error it is, not a pass or a 403", async () => {
    const h = harness('served', { scopeOf: 'fails' });
    const res = await h.send(LIMITED, 'POST', '/v1/mcp/endpoints/mcp-away/unregister', {});
    expect(res.status).toBe(500);
    expect(res.changed).toEqual([]);
  });

  test("an item's projects lookup that fails is the error it is, not a pass or a 403", async () => {
    const items = itemProjects(rows());
    const h = harness('served', {
      items: {
        ...items,
        projectsOf: async () => {
          throw new Error('test: the projects lookup failed');
        },
      },
    });
    const res = await h.send(LIMITED, 'POST', `/v1/agents/${AWAY}/versions/1.0.0/unregister`);
    expect(res.status).toBe(500);
    expect(res.changed).toEqual([]);
  });
});

describe("another project's item, by a key limited to a project, with a store", () => {
  test.each(HELD)('$label: refused by the store, as before', async (r) => {
    const res = await sendRow(withStore, LIMITED, r, 'away');
    expect([403, 404]).toContain(res.status);
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
    expect(res.changed).toEqual([]);
  });
});
