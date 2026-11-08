// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A deploy refused `409 <primitive>-project-mismatch` where the ids are live
 * in a test project (`Project.testFor`), or where it goes into one:
 *
 *   - the answer says where they're live, as far as the caller may know it:
 *     in their own test project, or in one they can read, by name and id;
 *     in another person's, by its kind alone. Any other project is never
 *     named, as before;
 *   - a test project joins no environment order, so on a runtime with one
 *     pack service the order fix isn't named, and the words say why; with a
 *     pack service per deployment, the copy fix stays;
 *   - the log keeps the project the ids are live in, whatever the answer
 *     says;
 *   - the wire is the same: the message alone changes.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import { generateEd25519KeyPair, serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';
import type { LogFields, Logger } from '@kindgi/log';
import { type ProjectBinding, makeInMemoryProjectBinding } from '@kindgi/platform';
import type { ProjectId, SigningKeyId, TenantId, UserId } from '@kindgi/types';

import { canonicalizeEnvelope } from '../src/deployment-envelope.js';
import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  Deployment,
  DeploymentBinding,
  ImageRegistryBinding,
  RunHandlerBinding,
  SigningKeyBinding,
  TokenResolver,
  TrustedKey,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { environmentOrders } from './support/environment-orders.js';

const tenantId = randomUUID() as TenantId;
/** The person deploying. */
const ME = 'user-me' as UserId;
/** Another person, whose test project the ids may be live in. */
const OTHER = 'user-other' as UserId;
/** The workspace's admin, who reads every project. */
const ADMIN = 'user-admin' as UserId;

const TOKENS: Record<string, UserId> = { 'me-token': ME, 'admin-token': ADMIN };
const resolveToken: TokenResolver = async (token) => {
  const userId = TOKENS[token];
  return userId === undefined ? null : { tenantId, userId };
};

const notUsed = async (): Promise<never> => {
  throw new Error('not used in these tests');
};
const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};

const AGENT_ID = 'acme.drafting';
const REFUSED = `The agent ${AGENT_ID}@1.0.0 wasn't published: it belongs to another project`;
const COPY_FIX =
  ' (one pack per client: `kindgi init` a copy of the pack for this client, with its own pack id)';
const ORDER_FIX =
  " (this runtime runs one pack service, so a copy of the pack wouldn't run: if both projects are in the same org, or neither is in an org, put them in one environment order (`kindgi environments set`), this one right after the one it belongs to, and `kindgi promote` the build to this one instead of deploying it; otherwise they can't share an order until both are in the same org, or neither is in an org (a project not in an order can move))";
const HOLDER_FIX =
  " (this runtime runs one pack service, so a copy of the pack wouldn't run, and a test project joins no environment order, so its builds can't be promoted to another project)";
const TARGET_FIX =
  " (this runtime runs one pack service, so a copy of the pack wouldn't run, and a test project joins no environment order: it takes only ids no other project holds)";

/** A runtime with one pack service and environment orders. */
const ORDERS = { environmentOrders: environmentOrders([]) };
/** What a runtime routing pack calls per deployment passes. */
const PER_DEPLOYMENT = {
  systemDeployments: {
    binding: {} as never,
    endpointHostAllowed: () => false,
  },
  // Each request the orchestrator's key makes is on record; these tests make none.
  systemAccessAudit: {
    record: async () => undefined,
    begin: async () => 'a',
    finish: async () => undefined,
  },
} as const;

const keyPair = generateEd25519KeyPair();
const RELEASE_KEY = 'acme-release';

const index = {
  v: 1,
  artifactVersion: '20261107.1',
  publishedAt: '2026-11-07T09:00:00.000Z',
  tools: [],
  guardrails: [],
  agents: [
    {
      id: AGENT_ID,
      version: '1.0.0',
      name: 'Drafting',
      instructions: 'do it',
      capabilities: [{ feature: 'model.text.chat' }],
      tools: [],
    },
  ],
  flows: [],
};
const indexBytes = new TextEncoder().encode(JSON.stringify(index));
const indexSha = createHash('sha256').update(indexBytes).digest('hex');
const DIGEST = `sha256:${indexSha}`;

const images: ImageRegistryBinding = {
  head: async () => ({
    kind: 'ok',
    value: {
      digest: DIGEST,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      size: indexBytes.length,
      layers: [{ digest: DIGEST, mediaType: 'x', size: indexBytes.length }],
      config: { digest: 'sha256:cfg', mediaType: 'x', size: 0 },
    },
  }),
  extractFile: async ({ path }) => ({
    kind: 'ok',
    value: { path, bytes: indexBytes, sha256: indexSha, layerDigest: DIGEST },
  }),
  push: notUsed,
};

const trusted: TrustedKey = {
  keyId: RELEASE_KEY as SigningKeyId,
  tenantId,
  algorithm: 'ed25519',
  publicKey: Buffer.from(keyPair.publicKey).toString('base64'),
  createdAt: '2026-11-01T00:00:00.000Z',
};
const signingKeys: SigningKeyBinding = {
  isTrusted: async ({ keyId, publicKey }) => ({
    kind: 'ok',
    value: keyId === trusted.keyId && publicKey === trusted.publicKey,
  }),
  verify: notUsed,
  listTrusted: async () => ({ data: [trusted] }),
  getTrusted: notUsed,
  addTrusted: notUsed,
  revokeTrusted: notUsed,
};

/** The deploy's body, signed by this file's key, into `projectId`. */
function deployInto(projectId: ProjectId): Record<string, unknown> {
  const envelope = canonicalizeEnvelope({
    imageDigest: DIGEST,
    artifactVersion: index.artifactVersion,
    indexHash: DIGEST,
    tenantId: tenantId as unknown as string,
    publishedAt: index.publishedAt,
  });
  const signature = signEd25519(keyPair.privateKey, envelope);
  if (signature.kind === 'err') throw new Error(signature.error.message);
  return {
    imageRef: `registry.acme.example/acme/pack@${DIGEST}`,
    artifactVersion: index.artifactVersion,
    indexHash: DIGEST,
    signerKeyId: RELEASE_KEY,
    signerPublicKey: serializePublicKeyPem(keyPair.publicKey),
    signature: Buffer.from(signature.value).toString('base64'),
    publishedAt: index.publishedAt,
    projectId,
  };
}

/** Deployments as registered: none, in these tests, as each deploy is refused before. */
function ledger() {
  const rows: Deployment[] = [];
  const binding: DeploymentBinding = {
    async register() {
      throw new Error('a refused deploy registers nothing');
    },
    get: async ({ deploymentId }) => rows.find((d) => d.deploymentId === deploymentId) ?? null,
    getByImageDigest: async ({ imageDigest, projectId }) =>
      rows.find((d) => d.imageDigest === imageDigest && d.projectId === projectId) ?? null,
    list: async () => ({ data: rows.slice() }),
  };
  return { binding, rows };
}

/** An agent registry where `AGENT_ID` is live in `holder()`, as a registry answers it. */
function agentsLiveIn(holder: () => ProjectId): AgentRegistryBinding {
  return {
    list: async () => ({ data: [] }),
    get: async () => null,
    getVersion: async () => null,
    headExists: async () => false,
    listVersions: async () => ({ data: [] }),
    async publish({ agent }) {
      return {
        kind: 'project-mismatch',
        agentId: agent.id,
        version: agent.version,
        projectId: holder(),
      };
    },
    unregister: async () => ({ unregistered: false }),
    markLatest: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
    reinstateVersion: async ({ agentId, version }) => ({ kind: 'not-found', agentId, version }),
  };
}

interface LogRecord {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that keeps each info and warn; a child is the same logger. */
function recordingLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const log: Logger & { records: LogRecord[] } = {
    records,
    error: () => undefined,
    warn: (message, fields) => void records.push({ level: 'warn', message, fields }),
    info: (message, fields) => void records.push({ level: 'info', message, fields }),
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
    isLevelEnabled: () => true,
  };
  return log;
}

/** The warns that a refused deploy's projects weren't read. */
const notReadWarns = (logger: ReturnType<typeof recordingLogger>) =>
  logger.records.filter(
    (r) =>
      r.level === 'warn' &&
      r.message.startsWith("a refused deploy's projects weren't read, so its answer names none"),
  );

type Place = 'team' | 'elsewhere' | 'mine' | 'theirs';

async function harness(opts: {
  /** Where the agent is live. */
  readonly holder: Place;
  /** Where the deploy goes. Default `team`. */
  readonly into?: Place;
  /** The runtime's pack bindings. Default `ORDERS`. */
  readonly runtime?: Partial<Parameters<typeof createApp>[0]>;
  /** With an authorization store (the default), only the admin reads `theirs`. */
  readonly authorization?: boolean;
  /** Reading the project the agent is live in throws. */
  readonly holderReadFails?: boolean;
  /** The authorization store can't answer whether the caller reads `theirs`. */
  readonly readCheckThrows?: boolean;
}) {
  const trio = makeInMemoryProjectBinding();
  const make = async (name: string, testFor?: UserId): Promise<ProjectId> => {
    const made = await trio.projects.create(tenantId, {
      name,
      slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      ...(testFor !== undefined && { testFor }),
    });
    if (made.kind !== 'ok') throw new Error(made.kind);
    return made.projectId;
  };
  const ids: Record<Place, ProjectId> = {
    team: await make('Team'),
    elsewhere: await make('Elsewhere'),
    mine: await make('Mine', ME),
    theirs: await make('Theirs', OTHER),
  };
  const holder = ids[opts.holder];
  const projectBinding: ProjectBinding = {
    ...trio.projects,
    async get(t, projectId) {
      if (opts.holderReadFails === true && projectId === holder) {
        throw new Error('the projects store is unreachable');
      }
      return trio.projects.get(t, projectId);
    },
  };

  // Every check is allowed but reading `theirs`, which only the admin may.
  const decide = (p: Principal, action: Action, resource: ResourceRef): Decision => {
    const readsTheirs =
      action === 'read' &&
      resource.type === 'project' &&
      resource.id === (ids.theirs as unknown as string);
    if (readsTheirs && opts.readCheckThrows === true) {
      // As a store that can't be reached answers (`AuthzCheckBinding`).
      throw Object.assign(new Error('the authorization store is unreachable'), {
        code: 'authz-backend-unavailable',
      });
    }
    const refused = readsTheirs && p.actor.id !== ADMIN;
    return {
      allowed: !refused,
      reason: refused ? 'test: not a reader' : 'test: granted',
      evidence: { action, relation: '', resource: '', actorSubject: '' },
    };
  };
  const authzCheckBinding = {
    check: async (p: Principal, a: Action, r: ResourceRef) => decide(p, a, r),
    checkBatch: async (p: Principal, a: Action, rs: readonly ResourceRef[]) =>
      rs.map((r) => decide(p, a, r)),
  } as unknown as AuthzCheckBinding;

  const deployments = ledger();
  const logger = recordingLogger();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    logger,
    deploymentRegistry: deployments.binding,
    signingKeyRegistry: signingKeys,
    imageRegistry: images,
    agentRegistry: agentsLiveIn(() => holder),
    projectBinding,
    projectMembershipBinding: trio.memberships,
    ...(opts.authorization !== false && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
    ...(opts.runtime ?? ORDERS),
  });
  const post = async (token: string) => {
    const res = await app.request('/v1/deployments', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(deployInto(ids[opts.into ?? 'team'])),
    });
    const text = await res.text();
    const body = JSON.parse(text) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    return { status: res.status, text, error: body.error };
  };
  return { ids, post, logger, deployments };
}

describe('a deploy whose agent is live in a test project', () => {
  test.each([
    { runs: 'one pack service, with environment orders', runtime: ORDERS, fix: HOLDER_FIX },
    { runs: 'a pack service per deployment', runtime: PER_DEPLOYMENT, fix: COPY_FIX },
    { runs: 'one pack service, no environment orders', runtime: {}, fix: '' },
  ])(
    "the caller's own, on a runtime with $runs: named as theirs, with the fix it has, nothing deployed",
    async ({ runtime, fix }) => {
      const h = await harness({ holder: 'mine', runtime });
      const answer = await h.post('me-token');
      expect(answer.status, answer.text).toBe(409);
      expect(answer.error.code).toBe('agent-project-mismatch');
      expect(answer.error.message).toBe(
        `${REFUSED}: it's live in your test project "Mine" (${h.ids.mine})${fix}; nothing was deployed`,
      );
      // The wire is the same: the message alone changes.
      expect(answer.error.details).toEqual({ primitive: 'agent', id: `${AGENT_ID}@1.0.0` });
      expect(h.deployments.rows).toEqual([]);
    },
  );

  test('a tenant admin, who reads every project: named as "the test project", not theirs', async () => {
    const h = await harness({ holder: 'theirs' });
    const answer = await h.post('admin-token');
    expect(answer.status, answer.text).toBe(409);
    expect(answer.error.message).toBe(
      `${REFUSED}: it's live in the test project "Theirs" (${h.ids.theirs})${HOLDER_FIX}; nothing was deployed`,
    );
  });

  test("another person's, which the caller can't read: its kind alone, never its name or id", async () => {
    const h = await harness({ holder: 'theirs' });
    const answer = await h.post('me-token');
    expect(answer.status, answer.text).toBe(409);
    expect(answer.error.message).toBe(
      `${REFUSED}: it's live in another person's test project${HOLDER_FIX}; nothing was deployed`,
    );
    expect(answer.text).not.toContain(h.ids.theirs);
    expect(answer.text).not.toContain('Theirs');
    expect(answer.text).not.toContain(OTHER);
  });

  test("with no authorization store, every caller reads every project: another person's is named", async () => {
    const h = await harness({ holder: 'theirs', authorization: false });
    const answer = await h.post('me-token');
    expect(answer.status, answer.text).toBe(409);
    expect(answer.error.message).toBe(
      `${REFUSED}: it's live in the test project "Theirs" (${h.ids.theirs})${HOLDER_FIX}; nothing was deployed`,
    );
  });

  test('the log keeps the project it is live in, which the answer leaves out', async () => {
    const h = await harness({ holder: 'theirs' });
    await h.post('me-token');
    expect(h.logger.records).toContainEqual({
      level: 'info',
      message: `${REFUSED}: deploy refused`,
      fields: {
        primitive: 'agent',
        id: `${AGENT_ID}@1.0.0`,
        ownerProjectId: h.ids.theirs as unknown as string,
      },
    });
  });

  test("its project can't be read: the words of a project that isn't a test project, and a warn", async () => {
    const h = await harness({ holder: 'mine', holderReadFails: true });
    const answer = await h.post('me-token');
    expect(answer.status, answer.text).toBe(409);
    expect(answer.error.message).toBe(`${REFUSED}${ORDER_FIX}; nothing was deployed`);
    expect(answer.text).not.toContain(h.ids.mine);
    expect(notReadWarns(h.logger)).toHaveLength(1);
  });

  test("the authorization store can't say whether the caller reads it: the same words and a warn, never another person's", async () => {
    const h = await harness({ holder: 'theirs', readCheckThrows: true });
    const answer = await h.post('me-token');
    expect(answer.status, answer.text).toBe(409);
    expect(answer.error.message).toBe(`${REFUSED}${ORDER_FIX}; nothing was deployed`);
    expect(answer.text).not.toContain(h.ids.theirs);
    expect(answer.text).not.toContain('Theirs');
    expect(notReadWarns(h.logger)).toHaveLength(1);
  });
});

describe("a deploy whose agent is live in a project that isn't a test project", () => {
  test('the same words as before, byte for byte: its project never named', async () => {
    const h = await harness({ holder: 'elsewhere' });
    const answer = await h.post('admin-token');
    expect(answer.status, answer.text).toBe(409);
    expect(answer.error.message).toBe(`${REFUSED}${ORDER_FIX}; nothing was deployed`);
    expect(answer.text).not.toContain(h.ids.elsewhere);
    expect(answer.text).not.toContain('Elsewhere');
  });

  test('into a test project: no order fix, and the words say why, its project never named', async () => {
    const h = await harness({ holder: 'elsewhere', into: 'mine' });
    const answer = await h.post('me-token');
    expect(answer.status, answer.text).toBe(409);
    expect(answer.error.message).toBe(`${REFUSED}${TARGET_FIX}; nothing was deployed`);
    expect(answer.text).not.toContain(h.ids.elsewhere);
  });
});
