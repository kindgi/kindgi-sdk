// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Publishing an existing id keeps it in its project. An agent, flow,
 * tool or eval suite belongs to the project its first version went to,
 * as a block does (`block-project-mismatch`): a version published under
 * another project is refused with `409 <kind>-project-mismatch`, even
 * for an admin of both projects, and nothing is written. The answer
 * doesn't name the project the id belongs to (the caller may not read
 * it); the request's log does. The same project keeps its check (`admin`
 * there), and a new id is unchanged.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-publish-project';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

const projectA = randomUUID();
const projectB = randomUUID();

interface PublishInput {
  readonly projectId: string;
  readonly agent?: { readonly id: string; readonly version: string };
  readonly flow?: { readonly id: string; readonly version: string };
  readonly tool?: { readonly id: string; readonly version: string };
  readonly suite?: { readonly id: string; readonly version: string };
}

/**
 * A registry that keeps an id in the project its first version went to,
 * as the runtime's registries do: a version under another project is
 * `project-mismatch`, and nothing is written. Only `publish` is reached.
 */
function projectRegistry(idField: string) {
  const owners = new Map<string, string>();
  const versions = new Set<string>();
  const written: string[] = [];
  async function publish(input: PublishInput) {
    const definition = input.agent ?? input.flow ?? input.tool ?? input.suite;
    if (definition === undefined) throw new Error('nothing to publish');
    const { id, version } = definition;
    const owner = owners.get(id);
    if (owner !== undefined && owner !== input.projectId) {
      return { kind: 'project-mismatch', [idField]: id, version, projectId: owner };
    }
    if (versions.has(`${id}@${version}`)) {
      return { kind: 'already-registered', [idField]: id, version };
    }
    owners.set(id, input.projectId);
    versions.add(`${id}@${version}`);
    written.push(`${id}@${version} in ${input.projectId}`);
    return { kind: 'ok', [idField]: id, version };
  }
  return { binding: { publish }, owners, written };
}

const KINDS = [
  {
    kind: 'agent',
    path: '/v1/agents',
    registry: 'agentRegistry',
    idField: 'agentId',
    id: 'acme.drafting',
    body: (version: string) => ({
      id: 'acme.drafting',
      version,
      name: 'Drafting Agent',
      instructions: 'Draft the document from the provided facts.',
      capabilities: [{ needs: [{ feature: 'structured-output' }] }],
      tools: [],
      retrieval: [],
      guardrails: [],
    }),
  },
  {
    kind: 'flow',
    path: '/v1/flows',
    registry: 'flowRegistry',
    idField: 'flowId',
    id: 'ingest.contract-pdf',
    body: (version: string) => ({
      id: 'ingest.contract-pdf',
      version,
      nodes: [{ id: 'extract', kind: 'tool', ref: 'inline' }],
      edges: [
        { id: 'e0', from: '$start', to: 'extract' },
        { id: 'e1', from: 'extract', to: '$end' },
      ],
    }),
  },
  {
    kind: 'tool',
    path: '/v1/tools',
    registry: 'toolRegistry',
    idField: 'toolId',
    id: 'acme.verify-citation',
    body: (version: string) => ({
      id: 'acme.verify-citation',
      description: 'Look up a citation.',
      version,
      input: { type: 'object', properties: { citation: { type: 'string' } } },
      output: { type: 'object', properties: { verified: { type: 'boolean' } } },
    }),
  },
  {
    kind: 'eval-suite',
    path: '/v1/eval-suites',
    registry: 'evalSuiteRegistry',
    idField: 'suiteId',
    id: 'acme.drafting-accuracy',
    body: (version: string) => ({
      id: 'acme.drafting-accuracy',
      version,
      kind: 'accuracy',
      spec: {
        cases: [{ input: 'draft a clause', expectedOutput: 'a clause' }],
        grader: { adapterId: 'eval-judge-ajv' },
      },
    }),
  },
] as const;

/** The app with one kind's registry, its id already in project A, and `admin` on `grants`. */
async function harness(k: (typeof KINDS)[number], grants: readonly string[]) {
  const registry = projectRegistry(k.idField);
  await registry.binding.publish({
    projectId: projectA,
    [k.kind === 'eval-suite' ? 'suite' : k.kind]: { id: k.id, version: '1.0.0' },
  });
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    const pair = `${action} ${r.type}:${r.id}`;
    asked.push(pair);
    const allowed = grants.some((projectId) => pair === `admin project:${projectId}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const lines: string[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    logger: createLogger({ write: (line) => lines.push(line) }),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    [k.registry]: registry.binding as never,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const publish = async (body: Record<string, unknown>) => {
    const res = await app.request(k.path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: JSON.parse(text) as {
        error?: { code: string; message: string; details?: Record<string, unknown> };
      },
    };
  };
  return { publish, asked, written: registry.written, lines };
}

describe.each(KINDS)('publishing an existing $kind id keeps it in its project', (k) => {
  test(`another project's id → 409 ${k.kind}-project-mismatch, and nothing is written`, async () => {
    const { publish, asked, written, lines } = await harness(k, [projectB]);
    const moved = await publish({ ...k.body('2.0.0'), projectId: projectB });
    expect(moved.status).toBe(409);
    expect(moved.body.error?.code).toBe(`${k.kind}-project-mismatch`);
    expect(moved.body.error?.message).toContain('belongs to another project');
    expect(moved.body.error?.details).toEqual({ [k.idField]: k.id });
    // The project it belongs to stays off the wire; the log keeps it.
    expect(moved.text).not.toContain(projectA);
    expect(lines.some((line) => line.includes(`"ownerProjectId":"${projectA}"`))).toBe(true);
    // The destination's check ran first, as before.
    expect(asked).toContain(`admin project:${projectB}`);
    expect(written).toEqual([`${k.id}@1.0.0 in ${projectA}`]);
  });

  test('an admin of both projects is refused too: no moves', async () => {
    const { publish, written } = await harness(k, [projectA, projectB]);
    const moved = await publish({ ...k.body('2.0.0'), projectId: projectB });
    expect(moved.status).toBe(409);
    expect(moved.body.error?.code).toBe(`${k.kind}-project-mismatch`);
    expect(written).toEqual([`${k.id}@1.0.0 in ${projectA}`]);
  });

  test('the same project → published, with admin there', async () => {
    const { publish, asked, written } = await harness(k, [projectA]);
    const next = await publish({ ...k.body('2.0.0'), projectId: projectA });
    expect(next.status).toBe(201);
    expect(asked).toContain(`admin project:${projectA}`);
    expect(written).toEqual([`${k.id}@1.0.0 in ${projectA}`, `${k.id}@2.0.0 in ${projectA}`]);
  });

  test('the same project without admin there → 403, as before', async () => {
    const { publish, written } = await harness(k, [projectB]);
    const next = await publish({ ...k.body('2.0.0'), projectId: projectA });
    expect(next.status).toBe(403);
    expect(next.body.error?.code).toBe('permission-denied');
    expect(written).toEqual([`${k.id}@1.0.0 in ${projectA}`]);
  });

  test('a new id → published into the body project, as before', async () => {
    const { publish, written } = await harness(k, [projectB]);
    const fresh = { ...k.body('1.0.0'), id: `${k.id}-new` };
    const res = await publish({ ...fresh, projectId: projectB });
    expect(res.status).toBe(201);
    expect(written).toEqual([`${k.id}@1.0.0 in ${projectA}`, `${k.id}-new@1.0.0 in ${projectB}`]);
  });
});
