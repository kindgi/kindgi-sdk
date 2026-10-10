// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/blocks`: versioned prompts and settings, authorized through each
 * block's project. A version never changes, nor does a block's kind; a
 * settings block's values satisfy its schema and the latest version's.
 * A block the caller can't read answers 404, as one that doesn't exist.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import type { OrgId, ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';

const tenantId = randomUUID() as TenantId;
const projectA = randomUUID() as ProjectId;
const projectB = randomUUID() as ProjectId;
const orgA = randomUUID() as OrgId;
const TOKEN = 'blocks-user-token';

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

interface Authz {
  readonly grants: readonly string[];
}

function decision(authz: Authz, action: Action, resource: ResourceRef): Decision {
  const allowed = authz.grants.includes(`${action} ${resource.type}:${resource.id}`);
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

function harness(authz?: Authz) {
  const binding = inMemoryBlocks([projectA, projectB], { [projectA]: orgA });
  const logLines: string[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    logger: createLogger({ write: (line) => logLines.push(line) }),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    blockRegistry: binding,
    ...(authz !== undefined && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, resource) => decision(authz, action, resource),
          checkBatch: async (_p, action, resources) =>
            resources.map((resource) => decision(authz, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  return { call, binding, logLines };
}

const prompt = (version: string, template = 'Sort the request for {{ firm }}.') => ({
  projectId: projectA,
  id: 'acme.intake-prompt',
  version,
  kind: 'prompt',
  content: { template, parameters: [{ name: 'firm', type: 'string', required: true }] },
});

const weights = (version: string, values: Record<string, unknown>, schema?: object) => ({
  projectId: projectA,
  id: 'acme.weights',
  version,
  kind: 'settings',
  content: { values, ...(schema !== undefined && { schema }) },
});

const weightsSchema = {
  type: 'object',
  properties: { recency: { type: 'number' }, relevance: { type: 'number' } },
  required: ['recency', 'relevance'],
  additionalProperties: false,
};

describe('/v1/blocks: publish and read', () => {
  test('a prompt and a settings block publish, list (latest of each), and read back', async () => {
    const { call } = harness();
    expect((await call('POST', '/v1/blocks', prompt('1.0.0'))).status).toBe(201);
    expect((await call('POST', '/v1/blocks', prompt('1.1.0'))).status).toBe(201);
    expect(
      (
        await call(
          'POST',
          '/v1/blocks',
          weights('1.0.0', { recency: 0.3, relevance: 0.7 }, weightsSchema),
        )
      ).status,
    ).toBe(201);

    const list = await call('GET', '/v1/blocks');
    expect(
      list.body.data.map((b: { id: string; version: string }) => `${b.id}@${b.version}`),
    ).toEqual(['acme.intake-prompt@1.1.0', 'acme.weights@1.0.0']);
    const prompts = await call('GET', '/v1/blocks?kind=prompt');
    expect(prompts.body.data).toHaveLength(1);

    const latest = await call('GET', '/v1/blocks/acme.intake-prompt');
    expect(latest.body).toMatchObject({ version: '1.1.0', kind: 'prompt', projectId: projectA });
    const old = await call('GET', '/v1/blocks/acme.intake-prompt/versions/1.0.0');
    expect(old.body.content.template).toBe('Sort the request for {{ firm }}.');
    const versions = await call('GET', '/v1/blocks/acme.intake-prompt/versions');
    expect(versions.body.data.map((b: { version: string }) => b.version)).toEqual([
      '1.1.0',
      '1.0.0',
    ]);
  });

  test('an invalid block is refused, naming each problem', async () => {
    const { call } = harness();
    const bad = await call('POST', '/v1/blocks', {
      projectId: projectA,
      id: 'Bad Id',
      version: 'v1',
      kind: 'prompt',
      content: { template: '{% if %}' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation-failed');
    expect(bad.body.error.details.issues.map((i: { path: string }) => i.path)).toEqual([
      '/id',
      '/version',
      '/content/template',
    ]);
  });

  test("settings values must satisfy their schema, and the latest version's", async () => {
    const { call } = harness();
    const wrong = await call(
      'POST',
      '/v1/blocks',
      weights('1.0.0', { recency: 'high' }, weightsSchema),
    );
    expect(wrong.status).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/v1/blocks',
          weights('1.0.0', { recency: 0.3, relevance: 0.7 }, weightsSchema),
        )
      ).status,
    ).toBe(201);

    // No schema of its own, but the latest's holds: a missing key is refused.
    const drift = await call('POST', '/v1/blocks', weights('1.1.0', { recency: 0.5 }));
    expect(drift.status).toBe(400);
    expect(drift.body.error.details.issues[0].message).toContain('(the schema of version 1.0.0)');
    expect(
      (await call('POST', '/v1/blocks', weights('1.1.0', { recency: 0.5, relevance: 0.5 }))).status,
    ).toBe(201);
  });

  test('a version that gives no schema keeps the latest one, so the check holds for every later version', async () => {
    const { call } = harness();
    const limits = (version: string, limit: number, schema?: object) =>
      call('POST', '/v1/blocks', {
        projectId: projectA,
        id: 'acme.limits',
        version,
        kind: 'settings',
        content: { values: { limit }, ...(schema !== undefined && { schema }) },
      });
    const nonNegative = {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 0 } },
      required: ['limit'],
    };
    expect((await limits('1.0.0', 10, nonNegative)).status).toBe(201);
    expect((await limits('1.1.0', 20)).status).toBe(201);
    // 1.1.0 restated nothing, but it keeps the schema, stored on it…
    const kept = await call('GET', '/v1/blocks/acme.limits/versions/1.1.0');
    expect(kept.body.content.schema).toEqual(nonNegative);
    // …so 1.2.0 is still checked.
    const refused = await limits('1.2.0', -1);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.issues[0].message).toContain('(the schema of version 1.1.0)');
  });

  test('a version that gives a schema replaces it; {} drops the check on purpose', async () => {
    const { call } = harness();
    const limits = (version: string, values: object, schema?: object) =>
      call('POST', '/v1/blocks', {
        projectId: projectA,
        id: 'acme.limits',
        version,
        kind: 'settings',
        content: { values, ...(schema !== undefined && { schema }) },
      });
    const closed = {
      type: 'object',
      properties: { limit: { type: 'number' } },
      additionalProperties: false,
    };
    expect((await limits('1.0.0', { limit: 10 }, closed)).status).toBe(201);
    // A new field the old schema forbids: allowed with a schema that names it.
    const wider = { ...closed, properties: { ...closed.properties, unit: { type: 'string' } } };
    expect((await limits('1.1.0', { limit: 10, unit: 'eur' }, wider)).status).toBe(201);
    expect((await limits('1.2.0', { limit: 'x' }, {})).status).toBe(201);
    expect((await limits('1.3.0', { anything: true })).status).toBe(201);
  });

  test("a version never changes, nor does the block's kind or project", async () => {
    const { call } = harness();
    expect((await call('POST', '/v1/blocks', prompt('1.0.0'))).status).toBe(201);
    const again = await call('POST', '/v1/blocks', prompt('1.0.0', 'Something else.'));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('block-already-registered');

    const kind = await call('POST', '/v1/blocks', {
      projectId: projectA,
      id: 'acme.intake-prompt',
      version: '2.0.0',
      kind: 'settings',
      content: { values: {} },
    });
    expect(kind.status).toBe(400);
    expect(kind.body.error.details.issues[0].message).toContain('is a prompt block');

    const moved = await call('POST', '/v1/blocks', { ...prompt('2.0.0'), projectId: projectB });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('block-project-mismatch');
  });

  test("another project's block: 409, and the answer doesn't name the project it belongs to (the log does)", async () => {
    const { call, logLines } = harness();
    expect((await call('POST', '/v1/blocks', prompt('1.0.0'))).status).toBe(201);
    const moved = await call('POST', '/v1/blocks', { ...prompt('2.0.0'), projectId: projectB });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('block-project-mismatch');
    expect(moved.body.error.message).toBe(
      'Block "acme.intake-prompt" belongs to another project; publish its versions there',
    );
    expect(moved.body.error.details).toEqual({ blockId: 'acme.intake-prompt' });
    expect(moved.text).not.toContain(projectA);
    expect(logLines.some((l) => l.includes(`"ownerProjectId":"${projectA}"`))).toBe(true);
  });

  test('unregister is soft: GET still reads the version, with unregisteredAt; reinstate brings it back', async () => {
    const { call } = harness();
    await call('POST', '/v1/blocks', prompt('1.0.0'));
    await call('POST', '/v1/blocks', prompt('1.1.0'));
    expect(
      (await call('POST', '/v1/blocks/acme.intake-prompt/versions/1.1.0/unregister')).status,
    ).toBe(200);
    expect((await call('GET', '/v1/blocks/acme.intake-prompt')).body.version).toBe('1.0.0');
    const read = await call('GET', '/v1/blocks/acme.intake-prompt/versions/1.1.0');
    expect(read.body.unregisteredAt).toBeDefined();
    const back = await call('POST', '/v1/blocks/acme.intake-prompt/versions/1.1.0/reinstate');
    expect(back.body).toEqual({
      blockId: 'acme.intake-prompt',
      version: '1.1.0',
      wasTombstoned: true,
    });
    expect((await call('GET', '/v1/blocks/acme.intake-prompt')).body.version).toBe('1.1.0');
  });
});

describe('/v1/blocks/{id}/versions: the cursor is checked', () => {
  const enc = (v: string) => Buffer.from(v, 'utf8').toString('base64url');
  test.each([
    [
      'a position',
      enc(
        JSON.stringify({
          p: '2026-10-09 12:00:00.123456+00',
          i: '6f1c2a4e-3b5d-4c7e-8f90-1a2b3c4d5e6f',
        }),
      ),
    ],
    ['a bare time, from before', enc('2026-10-09T12:00:00.123Z')],
  ])('%s: answered', async (_name, cursor) => {
    const { call } = harness();
    expect((await call('POST', '/v1/blocks', prompt('1.0.0'))).status).toBe(201);
    const res = await call('GET', `/v1/blocks/acme.intake-prompt/versions?cursor=${cursor}`);
    expect(res.status).toBe(200);
  });

  test.each([
    ['not base64 of anything', 'not-a-cursor'],
    ['a position whose time and id are not', enc(JSON.stringify({ p: 'x', i: 'y' }))],
    ['broken JSON', enc('{"p":')],
  ])('%s: 400 bad-input, never the first page again', async (_name, cursor) => {
    const { call } = harness();
    expect((await call('POST', '/v1/blocks', prompt('1.0.0'))).status).toBe(201);
    const res = await call('GET', `/v1/blocks/acme.intake-prompt/versions?cursor=${cursor}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
  });
});

describe('/v1/blocks: list by project or org, as the other lists do', () => {
  test('?scopeKind=project&scopeId= and ?scopeKind=org&scopeId= narrow the list', async () => {
    const { call, binding } = harness();
    await call('POST', '/v1/blocks', prompt('1.0.0'));
    await binding.publish({
      tenantId,
      projectId: projectB,
      block: { id: 'acme.other', version: '1.0.0', kind: 'settings', content: { values: {} } },
    });
    const ids = async (query: string) =>
      (await call('GET', `/v1/blocks${query}`)).body.data.map((b: { id: string }) => b.id);
    expect(await ids('')).toEqual(['acme.intake-prompt', 'acme.other']);
    expect(await ids(`?scopeKind=project&scopeId=${projectB}`)).toEqual(['acme.other']);
    expect(await ids(`?scopeKind=org&scopeId=${orgA}`)).toEqual(['acme.intake-prompt']);
    expect(await ids('?scopeKind=tenant')).toEqual(['acme.intake-prompt', 'acme.other']);
  });

  test('a malformed scope is refused (400 scope-invalid)', async () => {
    const { call } = harness();
    const res = await call('GET', '/v1/blocks?scopeKind=project');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('scope-invalid');
  });
});

describe('/v1/blocks: authorized through the project', () => {
  test('read on the project lists and reads; another project is invisible (404)', async () => {
    const { call, binding } = harness({
      grants: [`write project:${projectA}`, `read project:${projectA}`],
    });
    expect((await call('POST', '/v1/blocks', prompt('1.0.0'))).status).toBe(201);
    await binding.publish({
      tenantId,
      projectId: projectB,
      block: { id: 'acme.other', version: '1.0.0', kind: 'settings', content: { values: {} } },
    });
    const list = await call('GET', '/v1/blocks');
    expect(list.body.data.map((b: { id: string }) => b.id)).toEqual(['acme.intake-prompt']);
    expect((await call('GET', '/v1/blocks/acme.other')).status).toBe(404);
    expect((await call('GET', '/v1/blocks/acme.other/versions')).status).toBe(404);
  });

  test('publishing needs write on the project', async () => {
    const { call } = harness({ grants: [`read project:${projectA}`] });
    const res = await call('POST', '/v1/blocks', prompt('1.0.0'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('permission-denied');
  });
});
