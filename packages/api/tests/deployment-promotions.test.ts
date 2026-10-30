// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/deployments/:deploymentId/promotions` and its `/check` twin:
 *
 *   - the exact build moves (same digest, signature, signer, contents), each
 *     environment in turn, into a deployment of the target's own;
 *   - the edits of the build's versions move with it; another build's stay;
 *   - only the next environment of the order; read on the source's
 *     environment, admin on the target;
 *   - a superseded or suspended source or target copy, a signer no longer
 *     trusted, a signature that doesn't verify: refused, nothing written;
 *   - a value the build needs that isn't ready in the target: refused, each
 *     value named; the check lists the same ones and writes nothing;
 *   - a repeat answers the target's own deployment, and records only the
 *     edits made since;
 *   - a signed `deployment-promoted` event for each promotion that wrote.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { generateEd25519KeyPair, signEd25519 } from '@kindgi/crypto';
import type {
  AgentPinScope,
  Cursor,
  EnvName,
  ProjectId,
  RecordedSecretScope,
  Semver,
  SigningKeyId,
  TenantId,
  Timestamp,
  UserId,
  VersionDerivation,
} from '@kindgi/types';

import { canonicalizeEnvelope } from '../src/deployment-envelope.js';
import { agentTestSetId, createApp, resolveAtScope, scopeOfRecorded } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinInput,
  CarriedVersion,
  Deployment,
  DeploymentBinding,
  DeploymentContents,
  DeploymentEndpoint,
  Pin,
  PinVersionInput,
  PinnedVersionBinding,
  PromotedToolSecretScopes,
  ReleaseGate,
  RunHandlerBinding,
  TestRunBinding,
  TestSetFreezeBinding,
  TokenResolver,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';
import { inMemorySuggestedChanges } from './support/in-memory-suggested-changes.js';
import { noLatest } from './support/latest.js';
import { type ItemRow, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'promotions-token';
/** A key minted for S1 alone. */
const LIMITED = 'promotions-key-s1';
/** A token that may sync a deployment's secrets (`secrets:write`). */
const SECRETS = 'promotions-token-secrets';

const S1 = randomUUID() as ProjectId;
const S2 = randomUUID() as ProjectId;
/** The tenant's Default project, last in the order (an existing workspace's prod). */
const PROD = randomUUID() as ProjectId;
const OUTSIDE = randomUUID() as ProjectId;
const ORDER = [S1, S2, PROD];

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId, userId: 'user-1' as UserId };
  if (token === LIMITED) {
    return { tenantId, userId: 'user-1' as UserId, tokenProjectId: S1 as unknown as string };
  }
  if (token === SECRETS) {
    return { tenantId, userId: 'user-1' as UserId, capabilities: ['secrets:write'] };
  }
  return null;
};

const KEY_ID = 'acme-release' as SigningKeyId;
const keys = generateEd25519KeyPair();
const PUBLIC_KEY = Buffer.from(keys.publicKey).toString('base64');

const sha = (seed: string) => `sha256:${createHash('sha256').update(seed).digest('hex')}`;

const TOOL = { id: 'acme.lookup', version: '1.0.0' };
const SHIPS: DeploymentContents = {
  tools: [TOOL],
  guardrails: [{ id: 'acme.no-pii' }],
  agents: [{ id: 'acme.matcher', version: '1.0.0' }],
  flows: [],
};

let minute = 0;
/** A deployment the ledger has, signed over its own fields. */
function built(opts: {
  readonly id: string;
  readonly projectId?: ProjectId;
  readonly seed?: string;
  readonly contents?: DeploymentContents;
  readonly endpoint?: DeploymentEndpoint;
}): Deployment {
  minute += 1;
  const imageDigest = sha(opts.seed ?? 'build-1');
  const fields = {
    imageDigest,
    artifactVersion: '20261001.1',
    indexHash: sha(`index:${opts.seed ?? 'build-1'}`),
    tenantId: tenantId as unknown as string,
    publishedAt: '2026-10-01T09:00:00.000Z',
  };
  const signed = signEd25519(keys.privateKey, canonicalizeEnvelope(fields));
  if (signed.kind === 'err') throw new Error(signed.error.message);
  return {
    deploymentId: opts.id,
    tenantId,
    imageRef: `registry.acme.example/acme/pack@${imageDigest}`,
    imageDigest,
    artifactVersion: fields.artifactVersion,
    indexHash: fields.indexHash,
    signerKeyId: KEY_ID,
    signerPublicKey: PUBLIC_KEY,
    signature: Buffer.from(signed.value).toString('base64'),
    publishedAt: fields.publishedAt,
    activatedAt: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
    ...(opts.projectId !== undefined && { projectId: opts.projectId }),
    packId: 'acme.pack',
    ...(opts.endpoint !== undefined && { endpoint: opts.endpoint }),
    primitives: { tools: 1, guardrails: 1, agents: 1, flows: 0 },
    contents: opts.contents ?? SHIPS,
  };
}

const superseded: DeploymentEndpoint = {
  status: 'cleared',
  since: '2026-10-02T00:00:00.000Z',
  retired: 'superseded',
};

interface Ledger extends DeploymentBinding {
  readonly rows: Deployment[];
  /** The versions recorded with each deployment, by id. */
  readonly carried: Map<string, CarriedVersion[]>;
  readonly secretScopes: Map<string, readonly PromotedToolSecretScopes[]>;
}

const sameVersion = (a: CarriedVersion, b: CarriedVersion) =>
  a.kind === b.kind && a.id === b.id && a.version === b.version;

/** The deployment ledger, in memory: a digest once per project, the Default stored with none. */
function ledger(seeded: readonly Deployment[], opts: { promotes?: boolean } = {}): Ledger {
  const rows = [...seeded];
  const carried = new Map<string, CarriedVersion[]>();
  const secretScopes = new Map<string, readonly PromotedToolSecretScopes[]>();
  let seq = 0;
  // As the binding's contract: both stored forms of the Default (PROD) are the Default's.
  const inProject = (d: Deployment, projectId: ProjectId | undefined) =>
    projectId === undefined || projectId === PROD
      ? d.projectId === undefined || d.projectId === PROD
      : d.projectId === projectId;
  const binding: Ledger = {
    rows,
    carried,
    secretScopes,
    register: async () => {
      throw new Error('not asked: a promotion registers nothing');
    },
    get: async ({ deploymentId }) => rows.find((d) => d.deploymentId === deploymentId) ?? null,
    getByImageDigest: async ({ imageDigest, projectId }) =>
      rows.find((d) => d.imageDigest === imageDigest && inProject(d, projectId)) ?? null,
    async list({ limit, cursor, projectId, packId }) {
      const listed = rows
        .filter(
          (d) =>
            projectId === undefined ||
            d.projectId === projectId ||
            (projectId === PROD && d.projectId === undefined),
        )
        .filter((d) => packId === undefined || d.packId === packId)
        .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));
      const from = cursor === undefined ? 0 : Number(cursor);
      return {
        data: listed.slice(from, from + limit),
        ...(from + limit < listed.length && { nextCursor: String(from + limit) as Cursor }),
      };
    },
  };
  if (opts.promotes === false) return binding;
  return Object.assign(binding, {
    async promote(input: Parameters<NonNullable<DeploymentBinding['promote']>>[0]) {
      const source = rows.find((d) => d.deploymentId === input.sourceDeploymentId);
      if (source === undefined) {
        return { kind: 'error' as const, code: 'not-found', message: 'no source' };
      }
      const there = rows.find(
        (d) => d.imageDigest === source.imageDigest && inProject(d, input.projectId),
      );
      if (there !== undefined) {
        const had = carried.get(there.deploymentId) ?? [];
        const added = input.carried.filter((v) => !had.some((h) => sameVersion(h, v)));
        carried.set(there.deploymentId, [...had, ...added]);
        return { kind: 'already-registered' as const, deployment: there, carried: added };
      }
      seq += 1;
      minute += 1;
      const { projectId: _from, endpoint: _endpoint, ...copied } = source;
      const deployment: Deployment = {
        ...copied,
        deploymentId: `promoted-${seq}`,
        activatedAt: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        promotedFromDeploymentId: source.deploymentId,
      };
      rows.push(deployment);
      carried.set(deployment.deploymentId, [...input.carried]);
      secretScopes.set(deployment.deploymentId, input.toolSecretScopes);
      return { kind: 'ok' as const, deployment, carried: input.carried };
    },
  });
}

/** One agent version as the registry lists it. */
interface Row {
  readonly version: string;
  readonly derivedFrom?: VersionDerivation;
}
const deployedRow = (version: string, from?: string): Row => ({
  version,
  ...(from !== undefined && { derivedFrom: { version: from, reason: 'pins-changed' } }),
});
const editRow = (version: string, from: string): Row => ({
  version,
  derivedFrom: { version: from, reason: 'edited', label: 'warmer tone' },
});

function decision(grants: readonly string[], action: Action, resource: ResourceRef): Decision {
  const allowed = grants.includes(`${action} ${resource.type}:${resource.id}`);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

const notUsed = async (): Promise<never> => {
  throw new Error('not asked in these tests');
};

/**
 * A flow and tool pin binding that records every pin a promotion's `pin` asks for
 * and answers it pinned; a flow in `errorOn` fails its write (the error
 * only the write can give). `bindings` wires it into the app; with no
 * `how`, there's no binding and `asked` stays empty.
 */
function flowPinBinding(how: { readonly errorOn?: readonly string[] } | undefined) {
  const asked: PinVersionInput[] = [];
  if (how === undefined) return { asked, bindings: {} };
  const errorOn = how.errorOn ?? [];
  const binding: PinnedVersionBinding = {
    resolve: async () => null,
    list: async () => [],
    pin: async (input) => {
      if (errorOn.includes(input.itemId)) {
        return { kind: 'err', error: { code: 'persistence-error', message: 'write failed' } };
      }
      asked.push(input);
      return {
        kind: 'ok',
        value: {
          change: {
            id: randomUUID(),
            kind: input.kind,
            itemId: input.itemId,
            scope: input.scope,
            action: 'pin',
            fromVersion: null,
            toVersion: input.version,
            requestedBy: input.requestedBy,
            createdAt: '2026-10-27T07:00:00.000Z' as Timestamp,
          },
          unchanged: false,
        },
      };
    },
    unpin: notUsed,
    history: notUsed,
  };
  return { asked, bindings: { pinnedVersions: binding } };
}

/**
 * An agent pin binding that records every pin a promotion's `pin` asks for
 * and answers it pinned at once, with no gate. `pinned` is each `pin` input,
 * in order, so a test can read the scope the pin was set at.
 */
function agentPinBinding(
  opts: {
    readonly gated?: readonly string[] | undefined;
    /** Carried agents whose pin write fails (the error only the write can give). */
    readonly errorOn?: readonly string[] | undefined;
    /** Record gated promotions (`promotions.request`), so each pin goes through the gate. */
    readonly gate?: boolean | undefined;
  } = {},
): {
  readonly releases: AgentPinBindings;
  readonly pinned: AgentPinInput[];
} {
  const pinned: AgentPinInput[] = [];
  const errorOn = new Set(opts.errorOn ?? []);
  const changes = {
    pin: async (input: AgentPinInput) => {
      if (errorOn.has(input.agentId)) {
        return {
          kind: 'err' as const,
          error: { code: 'database-busy', message: 'The pin write failed.' },
        };
      }
      pinned.push(input);
      return {
        kind: 'ok' as const,
        value: {
          id: `pin-${pinned.length}`,
          agentId: input.agentId,
          scope: input.scope,
          action: 'pin',
          fromVersion: null,
          toVersion: input.version,
          requestedBy: input.requestedBy,
          createdAt: '2026-10-01T10:00:00.000Z' as Timestamp,
          ...(input.reason !== undefined && { reason: input.reason }),
        } satisfies Pin,
      };
    },
    ...(opts.gate === true && {
      request: async (input: PinRequestInput) => {
        pinned.push(input);
        return {
          kind: 'ok' as const,
          value: {
            id: `pin-${pinned.length}`,
            agentId: input.agentId,
            scope: input.scope,
            action: 'pin',
            fromVersion: null,
            toVersion: input.version,
            requestedBy: input.requestedBy,
            createdAt: '2026-10-01T10:00:00.000Z' as Timestamp,
            status: 'pinned',
          } satisfies Pin,
        };
      },
    }),
    unpin: notUsed,
    list: async () => ({ data: [] }),
    get: async () => null,
  };
  // A release gate on a carried agent's scope, so `pin` sees a gate it
  // can't record (this binding has no `changes.request`): `pin-
  // gate-unsupported`, decided before any pin.
  const gated = new Set(opts.gated ?? []);
  const releaseGates = {
    resolve: async ({ agentId, scope }: { agentId: string; scope: AgentPinScope }) =>
      gated.has(agentId)
        ? ({
            id: `gate-${agentId}`,
            version: '1',
            tenantId,
            agentId,
            scope,
            spec: {},
            createdAt: '2026-10-01T00:00:00.000Z' as Timestamp,
          } satisfies ReleaseGate)
        : null,
  };
  return {
    pinned,
    releases: {
      pinned: { resolve: async () => null, list: async () => [] },
      latest: noLatest,
      changes: changes as unknown as AgentPinBindings['changes'],
      ...(gated.size > 0 && {
        releaseGates: releaseGates as unknown as NonNullable<AgentPinBindings['releaseGates']>,
      }),
    },
  };
}

function harness(
  opts: {
    readonly rows?: readonly Deployment[];
    readonly promotes?: boolean;
    /** `<action> <type>:<id>`; absent: no authorization. */
    readonly grants?: readonly string[];
    readonly orders?: readonly (readonly ProjectId[])[];
    /** The agent's versions, which the carried versions are read from. */
    readonly versions?: Row[];
    /** Where a secret is set: `<scope kind>:<project id or empty>:<name>`. */
    readonly secrets?: readonly string[];
    readonly suspended?: readonly ProjectId[];
    /** The env the runtime serves; `null`: none named. */
    readonly envName?: string | null;
    /** The tool's schema for `ACME_TOKEN`; absent: a required string. */
    readonly secretSchema?: object;
    /** Wire an agent pin binding (`agentPinBinding`), so `pin` pins the carried agents. */
    readonly agentPins?: boolean;
    /** Carried agents whose scope has a release gate this binding can't record. */
    readonly gated?: readonly string[];
    /** Carried agents whose pin write fails (the error only the write can give). */
    readonly errorOn?: readonly string[];
    /** Each pin goes through the gate (`livePins`' `gate`). */
    readonly gate?: boolean;
    /** Items an order carries, so an agent spans more than one project. */
    readonly itemRows?: readonly ItemRow[];
    /** Wire a flow pin binding (`flowPinBinding`), so `pin` pins the carried flows; the flows named fail their write. */
    readonly flowPins?: { readonly errorOn?: readonly string[] };
    /** Wire suggested changes (`cardBindings`): the carried agent runs `pinned` in S2. */
    readonly cards?: { readonly pinned: string };
  } = {},
) {
  const deployments = ledger(opts.rows ?? [built({ id: 'dep-s1', projectId: S1 })], {
    ...(opts.promotes === false && { promotes: false }),
  });
  const trusted = { value: true };
  const appended: AuditEvent[] = [];
  const auditEvents: AuditEventBinding = {
    async append(events) {
      appended.push(...events);
      return { kind: 'ok', value: undefined };
    },
    query: notUsed,
    purge: notUsed,
    describe: () => ({ name: 'spy', version: '0' }),
  };
  const versions = { rows: opts.versions ?? [deployedRow('1.0.0')] };
  const secrets = opts.secrets ?? ['tenant::ACME_TOKEN'];
  const keyOf = (scope: { kind: string; projectId?: unknown }, name: string) =>
    `${scope.kind}:${(scope.projectId as string | undefined) ?? ''}:${name}`;
  /** What a secrets sync wrote, by `keyOf`; a call reads it at that scope only (`exact`). */
  const synced = new Map<string, string>();
  const secretsBinding = {
    get: async ({ scope, name }: { scope: { kind: string }; name: string }) =>
      secrets.includes(keyOf(scope, name)) || synced.has(keyOf(scope, name))
        ? { scope, envName: 'prod', name, currentVersion: 1 }
        : null,
    set: async (input: {
      scope: { kind: string };
      envName: string;
      name: string;
      value: string;
    }) => {
      synced.set(keyOf(input.scope, input.name), input.value);
      const at = '2026-10-18T00:00:00.000Z';
      return {
        kind: 'ok',
        record: {
          scope: input.scope,
          envName: input.envName,
          name: input.name,
          currentVersion: 1,
          createdAt: at,
          updatedAt: at,
        },
        versionId: 1,
      };
    },
    resolve: async ({ scope, name }: { scope: { kind: string }; name: string }) => {
      const value = synced.get(keyOf(scope, name));
      return value === undefined
        ? { kind: 'err', error: { code: 'secret-not-found', message: 'not set', name } }
        : { kind: 'ok', value: { name, versionId: 1, value, scope } };
    },
  };
  const grants = opts.grants;
  const agentPins =
    opts.agentPins === true || opts.cards !== undefined
      ? agentPinBinding({ gated: opts.gated, errorOn: opts.errorOn, gate: opts.gate })
      : undefined;
  const items = opts.itemRows !== undefined ? itemProjects([...opts.itemRows]) : undefined;
  const cards =
    opts.cards !== undefined && live !== undefined
      ? cardBindings(opts.cards.pinned, live)
      : undefined;
  const flowPins = flowPinBinding(opts.flowPins);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...(opts.envName !== null && { envName: (opts.envName ?? 'prod') as never }),
    deploymentRegistry: deployments,
    signingKeyRegistry: {
      isTrusted: async ({ keyId, publicKey }: { keyId: SigningKeyId; publicKey: string }) => ({
        kind: 'ok',
        value: trusted.value && keyId === KEY_ID && publicKey === PUBLIC_KEY,
      }),
    } as never,
    imageRegistry: { head: notUsed, extractFile: notUsed } as never,
    projectBinding: {
      get: async (_t: TenantId, id: ProjectId) => ({ id, tenantId }),
      getDefault: async () => ({ id: PROD, tenantId }),
    } as never,
    toolRegistry: {
      get: async () => null,
      getVersion: async ({ toolId, version }: { toolId: string; version: string }) =>
        toolId === TOOL.id && version === TOOL.version
          ? {
              ...TOOL,
              needsSpec: { secrets: { ACME_TOKEN: opts.secretSchema ?? { type: 'string' } } },
            }
          : null,
    } as never,
    agentRegistry: {
      // The gate reads the carried version; without it, nothing does.
      getVersion: async ({ agentId, version }: { agentId: string; version: string }) =>
        opts.gate === true || cards !== undefined ? { id: agentId, version } : null,
      listVersions: async () => ({ data: versions.rows }),
    } as never,
    secretsBinding: secretsBinding as never,
    environmentOrders: environmentOrders(opts.orders ?? [ORDER]),
    ...(agentPins !== undefined && { agentPins: agentPins.releases }),
    ...cards?.bindings,
    ...flowPins.bindings,
    ...(items !== undefined && { itemProjects: items }),
    ...(opts.suspended !== undefined && {
      projectSuspended: async (_t: TenantId, p: ProjectId) => opts.suspended?.includes(p) === true,
    }),
    auditEvents,
    ...(grants !== undefined && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, resource) => decision(grants, action, resource),
          checkBatch: async (_p, action, resources) =>
            resources.map((resource) => decision(grants, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (path: string, body: unknown, token = TOKEN) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return {
    deployments,
    trusted,
    appended,
    versions,
    /** The pins a promotion's `pin` asked for, in order (empty without `agentPins`). */
    pinned: agentPins?.pinned ?? [],
    /** The flow pins a promotion's `pin` asked for, in order (empty without `flowPins`). */
    flowPinned: flowPins.asked,
    promote: (id: string, toProjectId: ProjectId, reason?: string) =>
      call(`/v1/deployments/${id}/promotions`, {
        toProjectId,
        ...(reason !== undefined && { reason }),
      }),
    promoteAndPin: (id: string, toProjectId: ProjectId, token = TOKEN) =>
      call(`/v1/deployments/${id}/promotions`, { toProjectId, pin: true }, token),
    check: (id: string, toProjectId: ProjectId) =>
      call(`/v1/deployments/${id}/promotions/check`, { toProjectId }),
    // What `kindgi deploy --sync-secrets` asks of a deployment once it lands.
    sync: (id: string, value: string) =>
      call(
        `/v1/deployments/${id}/secrets`,
        { envName: 'prod', secrets: [{ name: 'ACME_TOKEN', value }] },
        SECRETS,
      ),
    // As a call reads a tool's secret: at the scope recorded for it, and there only.
    read: (recorded: RecordedSecretScope) =>
      resolveAtScope(secretsBinding as never, {
        scope: scopeOfRecorded(tenantId, recorded),
        envName: 'prod' as EnvName,
        name: 'ACME_TOKEN',
        resolveContext: { caller: 'dispatch' },
      }),
    call,
    /** The suggested changes stored so far (none without `cards`). */
    cardsNow: () => [...(cards?.supervisor.rows.values() ?? [])],
  };
}

/**
 * Suggested changes wired, for the cards a promotion makes in its target:
 * the carried agent runs `pinned` in S2 until a make-live pins another
 * (`live`'s pins). S2's test set has no cases yet, so a card is made
 * unchecked.
 */
function cardBindings(pinned: string, live: ReturnType<typeof livePins>) {
  const supervisor = inMemorySuggestedChanges();
  const testSetFreeze: TestSetFreezeBinding = {
    freezeTestSet: async ({ agentId, projectId }) => ({
      testSetId: agentTestSetId(agentId, projectId),
      testSetVersion: '1.0.0',
      cases: [],
    }),
  };
  const releases: AgentReleaseBindings = {
    ...live.releases,
    live: {
      resolve: async ({ projectId }) =>
        projectId === S2
          ? {
              version: (live.pinned.at(-1)?.version ?? pinned) as Semver,
              scope: { kind: 'project', projectId: S2 },
            }
          : null,
      list: async () => [],
    },
  };
  return {
    supervisor,
    bindings: {
      supervisor,
      blockRegistry: inMemoryBlocks(),
      testRunBinding: {} as TestRunBinding,
      testSetFreeze,
      agentReleases: releases,
    },
  };
}

const signedFields = (d: Deployment) => ({
  imageRef: d.imageRef,
  imageDigest: d.imageDigest,
  artifactVersion: d.artifactVersion,
  indexHash: d.indexHash,
  signerKeyId: d.signerKeyId,
  signerPublicKey: d.signerPublicKey,
  signature: d.signature,
  publishedAt: d.publishedAt,
  contents: d.contents,
});

describe('a promotion moves the exact build, one environment at a time', () => {
  test('staging-1 → staging-2 → prod: each a deployment of its own, with the source build', async () => {
    const h = harness();
    const source = h.deployments.rows[0] as Deployment;

    const first = await h.promote('dep-s1', S2);
    expect(first.status).toBe(201);
    expect(first.body.deployment).toMatchObject({
      ...signedFields(source),
      projectId: S2,
      promotedFromDeploymentId: 'dep-s1',
      packId: 'acme.pack',
    });
    expect(first.body.deployment.deploymentId).not.toBe('dep-s1');
    expect(first.body.moved).toEqual({
      packId: 'acme.pack',
      imageDigest: source.imageDigest,
      agents: [{ id: 'acme.matcher', version: '1.0.0' }],
      flows: [],
      tools: [TOOL],
      guardrails: [{ id: 'acme.no-pii' }],
    });

    const second = await h.promote(first.body.deployment.deploymentId, PROD);
    expect(second.status).toBe(201);
    // The Default is stored with no project, as a deploy naming none is.
    expect(second.body.deployment.projectId).toBeUndefined();
    expect(second.body.deployment).toMatchObject({
      ...signedFields(source),
      promotedFromDeploymentId: first.body.deployment.deploymentId,
    });
    expect(h.deployments.rows).toHaveLength(3);
  });

  test("the target's tool secret scopes are decided at the target", async () => {
    const h = harness({ secrets: [`project:${S2}:ACME_TOKEN`] });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(201);
    expect(h.deployments.secretScopes.get(res.body.deployment.deploymentId)).toEqual([
      {
        toolId: TOOL.id,
        version: TOOL.version,
        secretScopes: { ACME_TOKEN: { kind: 'project', projectId: S2 } },
      },
    ]);
  });

  test("an optional secret set nowhere is recorded at the target project, where the promoted deployment's sync writes", async () => {
    const optional = { type: ['string', 'null'] };
    // Without authorization (every scope counts), and as the tenant's admin.
    for (const grants of [
      undefined,
      [`read project:${S1}`, `admin project:${S2}`, `admin tenant:${tenantId}`],
    ]) {
      const h = harness({ secrets: [], secretSchema: optional, ...(grants && { grants }) });
      const res = await h.promote('dep-s1', S2);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(h.deployments.secretScopes.get(res.body.deployment.deploymentId)).toEqual([
        {
          toolId: TOOL.id,
          version: TOOL.version,
          secretScopes: { ACME_TOKEN: { kind: 'project', projectId: S2 } },
        },
      ]);
    }
  });

  test("an optional secret set nowhere, promoted into the Default project: recorded at the tenant, where the promoted deployment's sync writes", async () => {
    const optional = { type: ['string', 'null'] };
    // Without authorization (every scope counts), and as the tenant's admin.
    for (const grants of [
      undefined,
      // Reading the Default too: its sync reads the deployment first.
      [
        `read project:${S2}`,
        `read project:${PROD}`,
        `admin project:${PROD}`,
        `admin tenant:${tenantId}`,
      ],
    ]) {
      const h = harness({
        rows: [built({ id: 'dep-s2', projectId: S2 })],
        secrets: [],
        secretSchema: optional,
        ...(grants && { grants }),
      });
      const res = await h.promote('dep-s2', PROD);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const promoted = res.body.deployment.deploymentId as string;
      // The Default is stored with no project, so its sync writes the tenant.
      expect(res.body.deployment.projectId).toBeUndefined();
      const [tool] = h.deployments.secretScopes.get(promoted) ?? [];
      expect(tool?.secretScopes).toEqual({ ACME_TOKEN: { kind: 'tenant' } });
      const synced = await h.sync(promoted, 'acme-token-value');
      expect(synced.status, JSON.stringify(synced.body)).toBe(200);
      const read = await h.read(tool?.secretScopes.ACME_TOKEN as RecordedSecretScope);
      expect(read, JSON.stringify(read)).toMatchObject({
        kind: 'ok',
        value: { value: 'acme-token-value' },
      });
    }
  });

  test('twice, or twice at once: one deployment in the target, answered 200 after the first', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.promote('dep-s1', S2), h.promote('dep-s1', S2)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    // The body says it too, for a client that doesn't see the status.
    expect([a.body.created, b.body.created].sort()).toEqual([false, true]);
    expect(a.body.deployment.deploymentId).toBe(b.body.deployment.deploymentId);
    const again = await h.promote('dep-s1', S2);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.deployment.deploymentId).toBe(a.body.deployment.deploymentId);
    expect(h.deployments.rows.filter((d) => d.projectId === S2)).toHaveLength(1);
  });

  test("the target had the digest from before environments (adoption): 200 with the target's row", async () => {
    const h = harness({
      rows: [built({ id: 'dep-prod-old' }), built({ id: 'dep-s2', projectId: S2 })],
    });
    const res = await h.promote('dep-s2', PROD);
    expect(res.status).toBe(200);
    expect(res.body.deployment.deploymentId).toBe('dep-prod-old');
    expect(h.deployments.rows).toHaveLength(2);
  });

  test("adoption of a copy stored under the Default's id (a deploy that named it): 200 with that row, no second row", async () => {
    const h = harness({
      rows: [
        built({ id: 'dep-prod-named', projectId: PROD }),
        built({ id: 'dep-s2', projectId: S2 }),
      ],
    });
    const res = await h.promote('dep-s2', PROD);
    expect(res.status).toBe(200);
    expect(res.body.deployment.deploymentId).toBe('dep-prod-named');
    expect(h.deployments.rows).toHaveLength(2);
  });
});

describe('the edits that move with the build', () => {
  test('an edit of a version it ships moves with it; a later edit moves with a repeat', async () => {
    const h = harness({ versions: [deployedRow('1.0.0'), editRow('1.0.1', '1.0.0')] });
    const first = await h.promote('dep-s1', S2);
    expect(first.status).toBe(201);
    expect(first.body.moved.agents).toEqual([
      { id: 'acme.matcher', version: '1.0.0' },
      { id: 'acme.matcher', version: '1.0.1', carried: true },
    ]);
    const s2 = first.body.deployment.deploymentId as string;
    expect(h.deployments.carried.get(s2)).toEqual([
      { kind: 'agent', id: 'acme.matcher', version: '1.0.1' },
    ]);

    // Edited again in staging-1 after the promotion: it moves with the repeat.
    h.versions.rows = [...h.versions.rows, editRow('1.0.2', '1.0.1')];
    const repeat = await h.promote('dep-s1', S2);
    expect(repeat.status).toBe(200);
    expect(h.deployments.carried.get(s2)).toEqual([
      { kind: 'agent', id: 'acme.matcher', version: '1.0.1' },
      { kind: 'agent', id: 'acme.matcher', version: '1.0.2' },
    ]);
    // The repeat recorded something: its own event.
    expect(h.appended.map((e) => (e.payload as any).doc.carried)).toEqual([
      [{ kind: 'agent', id: 'acme.matcher', version: '1.0.1' }],
      [{ kind: 'agent', id: 'acme.matcher', version: '1.0.2' }],
    ]);
  });

  test('an edit of a version a later deploy registered (pins-changed) is left behind when the older build is promoted', async () => {
    const h = harness({
      versions: [
        deployedRow('1.0.0'),
        // Another deploy's build of the same agent, and an edit of it.
        deployedRow('1.1.0', '1.0.0'),
        editRow('1.1.1', '1.1.0'),
      ],
    });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(201);
    expect(res.body.moved.agents).toEqual([{ id: 'acme.matcher', version: '1.0.0' }]);
    expect(res.body.leftBehind).toEqual([
      { kind: 'agent', id: 'acme.matcher', version: '1.1.1', from: '1.1.0' },
    ]);
    expect(h.deployments.carried.get(res.body.deployment.deploymentId)).toEqual([]);
  });
});

describe('only the next environment', () => {
  test.each([
    ['a skipped environment', 'dep-s1', S1, PROD, { position: 1, nextProjectId: S2 }],
    ['the wrong direction', 'dep-s2', S2, S1, { position: 2, nextProjectId: PROD }],
    ['a project outside the order', 'dep-s1', S1, OUTSIDE, { position: 1, nextProjectId: S2 }],
  ] as const)(
    '%s: 409 promotion-not-next-environment, naming the next',
    async (_, id, from, to, details) => {
      const h = harness({ rows: [built({ id, projectId: from })] });
      const res = await h.promote(id, to);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('promotion-not-next-environment');
      expect(res.body.error.details).toEqual(details);
      expect(h.deployments.rows).toHaveLength(1);
    },
  );

  test('the last environment, and an environment in no order, have no next', async () => {
    const last = harness({ rows: [built({ id: 'dep-prod' })] });
    const fromLast = await last.promote('dep-prod', S1);
    expect(fromLast.status).toBe(409);
    expect(fromLast.body.error.message).toMatch(/last environment of its order/);
    expect(fromLast.body.error.details).toBeUndefined();

    const none = harness({ rows: [built({ id: 'dep-out', projectId: OUTSIDE })] });
    const fromNone = await none.promote('dep-out', S1);
    expect(fromNone.status).toBe(409);
    expect(fromNone.body.error.code).toBe('promotion-not-next-environment');
    expect(fromNone.body.error.message).toMatch(/in no environment order/);
  });

  test('the next environment is named only to a caller who reads it', async () => {
    const h = harness({ grants: [`read project:${S1}`, `admin project:${PROD}`] });
    const res = await h.promote('dep-s1', PROD);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ position: 1 });
  });
});

describe('rights on the projects themselves', () => {
  test('a key limited to a project neither promotes nor checks, with an authorizer or without: 403 key-project-mismatch', async () => {
    const setups = [harness(), harness({ grants: [`read project:${S1}`, `admin project:${S2}`] })];
    for (const h of setups) {
      for (const path of ['promotions', 'promotions/check']) {
        const res = await h.call(`/v1/deployments/dep-s1/${path}`, { toProjectId: S2 }, LIMITED);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('key-project-mismatch');
        expect(res.body.error.details).toMatchObject({
          keyProjectId: S1,
          projectId: S2,
          action: path === 'promotions' ? 'write' : 'read',
        });
      }
      expect(h.deployments.rows).toHaveLength(1);
      expect(h.appended).toEqual([]);
    }
  });

  test("read on the source's environment and admin on the target is enough: no tenant right", async () => {
    const h = harness({
      grants: [`read project:${S1}`, `admin project:${S2}`, `admin project:${S2}`],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(201);
  });

  test("a deployment the caller can't read answers as a missing one: 404", async () => {
    const h = harness({ grants: [`admin project:${S2}`] });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('deployment-not-found');
    const missing = await h.promote('dep-none', S2);
    expect(missing.status).toBe(404);
    // The same answer, word for word, but for the id asked about (and the request's own id).
    const { requestId: _unreadable, ...unreadable } = res.body.error;
    const { requestId: _missing, ...absent } = missing.body.error;
    expect(JSON.stringify(unreadable).replaceAll('dep-s1', 'dep-none')).toBe(
      JSON.stringify(absent),
    );
  });

  test('no admin on the target: 403, nothing written', async () => {
    const h = harness({ grants: [`read project:${S1}`, `read project:${S2}`] });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ action: 'admin', resource: `project:${S2}` });
    expect(h.deployments.rows).toHaveLength(1);
  });

  test("a secret the promoter doesn't administer isn't recorded for them: it's missing", async () => {
    const h = harness({ grants: [`read project:${S1}`, `admin project:${S2}`] });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(409);
    expect(res.body.error.details.values).toEqual([
      {
        name: 'ACME_TOKEN',
        kind: 'secret',
        neededBy: { type: 'tool', id: TOOL.id, version: TOOL.version },
        problem: 'missing',
      },
    ]);
  });
});

describe('the values check', () => {
  test("a value the build needs that isn't set in the target: 409, named, nothing written", async () => {
    // Set in staging-1 only: values never cross environments.
    const h = harness({ secrets: [`project:${S1}:ACME_TOKEN`] });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('promotion-values-not-ready');
    expect(res.body.error.details.values).toEqual([
      {
        name: 'ACME_TOKEN',
        kind: 'secret',
        neededBy: { type: 'tool', id: TOOL.id, version: TOOL.version },
        problem: 'missing',
      },
    ]);
    expect(h.deployments.rows).toHaveLength(1);
    expect(h.appended).toHaveLength(0);
  });

  test('the check lists the same values, what would move and the next environment; it writes nothing', async () => {
    const h = harness({
      secrets: [`project:${S1}:ACME_TOKEN`],
      versions: [deployedRow('1.0.0'), editRow('1.0.1', '1.0.0')],
    });
    const refused = await h.promote('dep-s1', S2);
    const res = await h.check('dep-s1', S2);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      moves: {
        packId: 'acme.pack',
        imageDigest: sha('build-1'),
        agents: [
          { id: 'acme.matcher', version: '1.0.0' },
          { id: 'acme.matcher', version: '1.0.1', carried: true },
        ],
        flows: [],
        tools: [TOOL],
        guardrails: [{ id: 'acme.no-pii' }],
      },
      values: refused.body.error.details.values,
      nextEnvironment: { projectId: S2, position: 1 },
      envName: 'prod',
    });
    expect(h.deployments.rows).toHaveLength(1);
  });

  test("the check names the env the runtime serves, where the target's values are set; none named, none given", async () => {
    const served = await harness({ envName: 'production' }).check('dep-s1', S2);
    expect(served.body.envName).toBe('production');
    const unnamed = await harness({ envName: null }).check('dep-s1', S2);
    expect(unnamed.status).toBe(200);
    expect(unnamed.body).not.toHaveProperty('envName');
  });

  test('the check refuses as the promotion does', async () => {
    const h = harness();
    const res = await h.check('dep-s1', PROD);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('promotion-not-next-environment');
  });
});

describe('a build moves only while it serves and its signature holds', () => {
  test('a superseded source: 409 deployment-superseded, naming the newer deployment', async () => {
    const h = harness({
      rows: [
        built({ id: 'dep-old', projectId: S1, endpoint: superseded }),
        built({ id: 'dep-new', projectId: S1, seed: 'build-2' }),
      ],
    });
    const res = await h.promote('dep-old', S2);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('deployment-superseded');
    expect(res.body.error.details).toEqual({ environment: 'source', newerDeploymentId: 'dep-new' });
  });

  test('a superseded copy in the Default stored under its id: 409, as one stored with no project', async () => {
    const h = harness({
      rows: [
        built({ id: 'dep-s2', projectId: S2 }),
        built({ id: 'dep-prod-copy', projectId: PROD, endpoint: superseded }),
        built({ id: 'dep-prod-new', seed: 'build-2' }),
      ],
    });
    const res = await h.promote('dep-s2', PROD);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('deployment-superseded');
    expect(res.body.error.details).toEqual({
      environment: 'target',
      newerDeploymentId: 'dep-prod-new',
    });
    expect(h.deployments.rows).toHaveLength(3);
  });

  test("a superseded copy in the target: 409, naming the target's newer deployment", async () => {
    const h = harness({
      rows: [
        built({ id: 'dep-s1', projectId: S1 }),
        built({ id: 'dep-s2-copy', projectId: S2, endpoint: superseded }),
        built({ id: 'dep-s2-new', projectId: S2, seed: 'build-2' }),
      ],
    });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({
      environment: 'target',
      newerDeploymentId: 'dep-s2-new',
    });
    expect(h.deployments.carried.size).toBe(0);
  });

  test("a suspension: the suspension's own code", async () => {
    const retired = harness({
      rows: [
        built({
          id: 'dep-s1',
          projectId: S1,
          endpoint: {
            status: 'cleared',
            since: '2026-10-02T00:00:00.000Z',
            retired: 'project-suspended',
          },
        }),
      ],
    });
    const fromSuspended = await retired.promote('dep-s1', S2);
    expect(fromSuspended.status).toBe(409);
    expect(fromSuspended.body.error).toMatchObject({
      code: 'project-suspended',
      details: { environment: 'source' },
    });

    const target = harness({ suspended: [S2] });
    const intoSuspended = await target.promote('dep-s1', S2);
    expect(intoSuspended.status).toBe(409);
    expect(intoSuspended.body.error).toMatchObject({
      code: 'project-suspended',
      details: { environment: 'target' },
    });
  });

  test('the signer revoked after the deploy: 403 signer-not-trusted', async () => {
    const h = harness();
    h.trusted.value = false;
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'signer-not-trusted',
      details: { signerKeyId: KEY_ID },
    });
    expect(h.deployments.rows).toHaveLength(1);
  });

  test("a signature that doesn't verify over the fields the deployment keeps: 400 signature-invalid", async () => {
    const row = built({ id: 'dep-s1', projectId: S1 });
    const h = harness({ rows: [{ ...row, artifactVersion: '20261001.2' }] });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('signature-invalid');
  });
});

describe('the record, and what a promotion takes', () => {
  test('a signed deployment-promoted event, with the reason; none for a repeat that wrote nothing', async () => {
    const h = harness();
    const res = await h.promote('dep-s1', S2, 'release 42');
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      kind: 'deployment-promoted',
      outcome: 'succeeded',
      projectId: S2,
      payload: {
        doc: {
          sourceDeploymentId: 'dep-s1',
          deploymentId: res.body.deployment.deploymentId,
          fromProjectId: S1,
          toProjectId: S2,
          imageDigest: sha('build-1'),
          created: true,
          carried: [],
          reason: 'release 42',
        },
      },
    });
    await h.promote('dep-s1', S2);
    expect(h.appended).toHaveLength(1);
  });

  test('a runtime that cannot promote: 501 after the rights checks; the check still answers', async () => {
    const h = harness({ promotes: false });
    const res = await h.promote('dep-s1', S2);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('promotions-unsupported');
    expect((await h.check('dep-s1', S2)).status).toBe(200);
    const denied = harness({ promotes: false, grants: [`read project:${S1}`] });
    expect((await denied.promote('dep-s1', S2)).status).toBe(403);
  });

  test('the body: toProjectId, and a reason only on the promotion', async () => {
    const h = harness();
    const bad = [
      await h.call('/v1/deployments/dep-s1/promotions', {}),
      await h.call('/v1/deployments/dep-s1/promotions', { toProjectId: S2, extra: 1 }),
      await h.call('/v1/deployments/dep-s1/promotions', {
        toProjectId: S2,
        reason: 'x'.repeat(1001),
      }),
      await h.call('/v1/deployments/dep-s1/promotions/check', { toProjectId: S2, reason: 'x' }),
    ];
    expect(bad.map((r) => [r.status, r.body.error.code])).toEqual([
      [400, 'bad-input'],
      [400, 'bad-input'],
      [400, 'bad-input'],
      [400, 'bad-input'],
    ]);
    expect(h.deployments.rows).toHaveLength(1);
  });
});

describe('pinning the carried agents in the target (pin)', () => {
  const AGENT = 'acme.matcher';

  test('pins each carried agent in the target and reports it pinned; an agent one project serves is asked the pin right', async () => {
    const h = harness({
      agentPins: true,
      grants: [`read project:${S1}`, `admin project:${S2}`, `pin agent:${AGENT}`],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(201);
    expect(res.body.pinned).toEqual([{ id: AGENT, version: '1.0.0', pinned: true }]);
    // Pinned in the target, at the target's own project scope — never the tenant's.
    expect(h.pinned).toHaveLength(1);
    expect(h.pinned[0]).toMatchObject({
      agentId: AGENT,
      version: '1.0.0',
      scope: { kind: 'project', projectId: S2 },
    });
  });

  test("refused when the caller can't pin an agent one project serves: 403, though the build has already moved", async () => {
    const h = harness({
      agentPins: true,
      grants: [`read project:${S1}`, `admin project:${S2}`],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ action: 'pin', resource: `agent:${AGENT}` });
    // The promotion committed (the move isn't undone); nothing was pinned.
    expect(h.deployments.rows.some((d) => d.projectId === S2)).toBe(true);
    expect(h.pinned).toEqual([]);
  });

  test('an agent an order carries is asked admin on the target project, not its home: a target admin who runs neither the source nor the home pins it', async () => {
    const h = harness({
      agentPins: true,
      // `acme.matcher` runs in S1 (its home) and S2 (the target).
      itemRows: [{ kind: 'agent', id: AGENT, projects: [S1, S2] }],
      // Admin on the target S2 and read on the source S1 — but no admin on the home S1.
      grants: [`read project:${S1}`, `admin project:${S2}`],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(201);
    expect(res.body.pinned).toEqual([{ id: AGENT, version: '1.0.0', pinned: true }]);
    expect(h.pinned[0]).toMatchObject({ scope: { kind: 'project', projectId: S2 } });
  });

  test('admin on the source alone, not the target: the promotion is refused before anything is pinned', async () => {
    const h = harness({
      agentPins: true,
      grants: [`read project:${S1}`, `admin project:${S1}`],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ action: 'admin', resource: `project:${S2}` });
    expect(h.pinned).toEqual([]);
    expect(h.deployments.rows.filter((d) => d.projectId === S2)).toHaveLength(0);
  });

  test('pinning it again is safe: the move is idempotent and a pin in place passes, with the same answer', async () => {
    const h = harness({
      agentPins: true,
      grants: [`read project:${S1}`, `admin project:${S2}`, `pin agent:${AGENT}`],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const first = await h.promoteAndPin('dep-s1', S2);
    const again = await h.promoteAndPin('dep-s1', S2);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    // The target already has the build, so the repeat answers 200 — and pins
    // it again all the same, with the same answer.
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.pinned).toEqual(first.body.pinned);
    // One deployment in the target; the pin was asked both times (in place, a no-op the binding absorbs).
    expect(h.deployments.rows.filter((d) => d.projectId === S2)).toHaveLength(1);
    expect(h.pinned).toHaveLength(2);
  });

  test('pinned in the Default project: the pin names that project, so a Default run resolves it over an older tenant-wide pin', async () => {
    const h = harness({
      agentPins: true,
      rows: [built({ id: 'dep-s2', projectId: S2 })],
    });
    const res = await h.promoteAndPin('dep-s2', PROD);
    expect(res.status).toBe(201);
    expect(res.body.pinned).toEqual([{ id: AGENT, version: '1.0.0', pinned: true }]);
    // A project-kind pin on the Default — never tenant- or org-wide — so it
    // takes precedence over an older tenant pin when a Default run resolves its version.
    expect(h.pinned).toHaveLength(1);
    expect(h.pinned[0]?.scope).toEqual({ kind: 'project', projectId: PROD });
  });

  test("a composition without an agent pin binding can't pin what a promotion carries: 501, the move still done", async () => {
    const h = harness();
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('promotions-unsupported');
    expect(res.body.error.message).toBe(
      "The build moved, but this runtime can't pin versions, so nothing was pinned in the target. Promote without `pin` here; the move is already done.",
    );
    // The build moved; only pinning what it carried is unsupported.
    expect(h.deployments.rows.some((d) => d.projectId === S2)).toBe(true);
  });

  // S2: everything decidable before a pin is decided for every agent first,
  // so a later agent's gate the deployment can't record never leaves an
  // earlier agent pinned on its own.
  test('a later carried agent whose scope is gated, in a deployment that can’t record a gated promotion: refused before any pin, nothing pinned', async () => {
    const GATED_AGENT = 'acme.ranker';
    const h = harness({
      agentPins: true,
      gated: [GATED_AGENT],
      rows: [
        built({
          id: 'dep-s1',
          projectId: S1,
          contents: {
            ...SHIPS,
            agents: [
              { id: AGENT, version: '1.0.0' },
              { id: GATED_AGENT, version: '1.0.0' },
            ],
          },
        }),
      ],
      grants: [
        `read project:${S1}`,
        `admin project:${S2}`,
        `pin agent:${AGENT}`,
        `pin agent:${GATED_AGENT}`,
      ],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('pin-gate-unsupported');
    // The first agent is not left pinned: the gate is decided before any pin.
    expect(h.pinned).toEqual([]);
    // Nothing was pinned, so the refusal carries no `pinned` (assert the error
    // body, not a top-level field that an error answer never has).
    expect(res.body.error.details?.pinned).toBeUndefined();
    // The build still moved — only pinning the carried agents is refused.
    expect(h.deployments.rows.some((d) => d.projectId === S2)).toBe(true);
  });

  // S3: an error only the pin write can give, after an earlier agent is
  // already pinned, answers with the pins made so far in `error.details.pinned`.
  test('a later carried agent’s pin write fails after an earlier one is pinned: the error carries the pins already made', async () => {
    const FAILS = 'acme.ranker';
    const h = harness({
      agentPins: true,
      errorOn: [FAILS],
      rows: [
        built({
          id: 'dep-s1',
          projectId: S1,
          contents: {
            ...SHIPS,
            agents: [
              { id: AGENT, version: '1.0.0' },
              { id: FAILS, version: '1.0.0' },
            ],
          },
        }),
      ],
      grants: [
        `read project:${S1}`,
        `admin project:${S2}`,
        `pin agent:${AGENT}`,
        `pin agent:${FAILS}`,
      ],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('database-busy');
    // The write failed on the second agent, but the first is already pinned, so
    // the answer names it (its `pinned` shape) rather than hiding it.
    expect(res.body.error.details?.pinned).toEqual([{ id: AGENT, version: '1.0.0', pinned: true }]);
    expect(h.pinned).toHaveLength(1);
    expect(h.pinned[0]).toMatchObject({ agentId: AGENT });
  });
  test("a first promotion carrying only a version made for a project: nothing runs in the target yet, so it isn't made live (409), and the move stays", async () => {
    // The carried version isn't Latest by being carried, and the target has
    // no pin and no other Latest: the gate has nothing to measure it against.
    const h = harness({
      live: true,
      gate: true,
      grants: [`read project:${S1}`, `admin project:${S2}`, `promote agent:${AGENT}`],
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.makeLive('dep-s1', S2);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('nothing-runs-in-scope');
    expect(res.body.error.message).toContain(`agent "${AGENT}" 1.0.0 wasn't made live`);
    expect(res.body.error.message).toContain(
      'Promote a build that ships a version of it, then make it live. If this version came from a suggested change',
    );
    expect(h.deployments.rows.some((d) => d.projectId === S2)).toBe(true);
    expect(h.pinned).toEqual([]);
  });
});

describe('making the carried flows the ones in use in the target (pin)', () => {
  const AGENT = 'acme.matcher';
  const FLOW = 'acme.refunds';
  const LATER = 'acme.returns';
  const shipsFlows = (...flows: string[]) =>
    built({
      id: 'dep-s1',
      projectId: S1,
      contents: { ...SHIPS, flows: flows.map((id) => ({ id, version: '1.0.0' })) },
    });
  const grants = (...extra: string[]) => [
    `read project:${S1}`,
    `admin project:${S2}`,
    `pin agent:${AGENT}`,
    ...extra,
  ];

  test('pins each carried flow version in the target project, after the agents, and reports it in pinnedFlows; a flow one project serves is asked the pin right', async () => {
    const h = harness({
      agentPins: true,
      flowPins: {},
      rows: [shipsFlows(FLOW)],
      grants: grants(`pin flow:${FLOW}`),
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(201);
    expect(res.body.pinned).toEqual([{ id: AGENT, version: '1.0.0', pinned: true }]);
    expect(res.body.pinnedFlows).toEqual([{ id: FLOW, version: '1.0.0' }]);
    // The target project's own pin: never the org's or the tenant's.
    expect(h.flowPinned).toHaveLength(1);
    expect(h.flowPinned[0]).toMatchObject({
      kind: 'flow',
      itemId: FLOW,
      version: '1.0.0',
      scope: { kind: 'project', projectId: S2 },
    });
  });

  test("refused when the caller can't pin a flow one project serves: 403 before any pin, an agent's included", async () => {
    const h = harness({
      agentPins: true,
      flowPins: {},
      rows: [shipsFlows(FLOW)],
      grants: grants(),
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ action: 'pin', resource: `flow:${FLOW}` });
    expect(h.pinned).toEqual([]);
    expect(h.flowPinned).toEqual([]);
    // The build still moved.
    expect(h.deployments.rows.some((d) => d.projectId === S2)).toBe(true);
  });

  test('a flow an order carries is asked admin on the target project, which the promotion needs anyway', async () => {
    const h = harness({
      agentPins: true,
      flowPins: {},
      rows: [shipsFlows(FLOW)],
      itemRows: [{ kind: 'flow', id: FLOW, projects: [S1, S2] }],
      grants: grants(),
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(201);
    expect(res.body.pinnedFlows).toEqual([{ id: FLOW, version: '1.0.0' }]);
  });

  test('a later carried flow’s pin write fails: the error carries the agents and flows pinned so far', async () => {
    const h = harness({
      agentPins: true,
      flowPins: { errorOn: [LATER] },
      rows: [shipsFlows(FLOW, LATER)],
      grants: grants(`pin flow:${FLOW}`, `pin flow:${LATER}`),
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await h.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('persistence-error');
    expect(res.body.error.details?.pinned).toEqual([{ id: AGENT, version: '1.0.0', pinned: true }]);
    expect(res.body.error.details?.pinnedFlows).toEqual([{ id: FLOW, version: '1.0.0' }]);
    expect(h.flowPinned.map((p) => p.itemId)).toEqual([FLOW]);
  });

  test("without a pin binding nothing pins a flow, so the answer has no pinnedFlows; a promotion that doesn't ask to pin pins none either", async () => {
    const without = harness({
      agentPins: true,
      rows: [shipsFlows(FLOW)],
      grants: grants(),
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const res = await without.promoteAndPin('dep-s1', S2);
    expect(res.status).toBe(201);
    expect(res.body.pinnedFlows).toBeUndefined();

    const plain = harness({
      agentPins: true,
      flowPins: {},
      rows: [shipsFlows(FLOW)],
      grants: grants(`pin flow:${FLOW}`),
      secrets: [`project:${S2}:ACME_TOKEN`],
    });
    const moved = await plain.promote('dep-s1', S2);
    expect(moved.status).toBe(201);
    expect(moved.body.pinnedFlows).toBeUndefined();
    expect(plain.flowPinned).toEqual([]);
  });
});

describe('the cards a promotion makes in the target', () => {
  const AGENT = 'acme.matcher';

  test("a target pinned to another version gets a card for each carried agent version, made by the target's new deployment", async () => {
    const h = harness({ cards: { pinned: '0.9.0' }, secrets: [`project:${S2}:ACME_TOKEN`] });
    const res = await h.promote('dep-s1', S2);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const cards = h.cardsNow();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      agentId: AGENT,
      fromVersion: '0.9.0',
      scope: { kind: 'project', projectId: S2 },
      tier: 'code',
      change: { deploymentId: res.body.deployment.deploymentId },
      madeBy: { kind: 'deploy', deploymentId: res.body.deployment.deploymentId },
      candidate: { agentVersion: '1.0.0' },
    });
    expect(res.body.deployment.deploymentId).not.toBe('dep-s1');
  });

  test('made live in the same promotion, the target runs it: no card', async () => {
    const h = harness({ cards: { pinned: '0.9.0' }, secrets: [`project:${S2}:ACME_TOKEN`] });
    const res = await h.makeLive('dep-s1', S2);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.cardsNow()).toHaveLength(0);
  });
});
