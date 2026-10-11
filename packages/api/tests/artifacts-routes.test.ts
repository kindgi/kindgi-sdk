// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/artifacts` over an in-memory blob store: every artifact belongs to
 * a project (its owner run's, else the upload's `projectId`, else the
 * default project), reads need `read` there and writes `write`, and an
 * upload over the cap is `413 artifact-too-large`.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { BlobMeta, BlobStorageBinding } from '@kindgi/blob-binding';
import type { RunBinding } from '@kindgi/runtime';
import type { ArtifactId, ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000b1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const RUN_IN_P2 = '00000000-0000-4000-8000-0000000000c2';

/** Alice reads and writes P1 and reads P2; Bob has nothing. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  alice: [`read:project:${P1}`, `write:project:${P1}`, `read:project:${P2}`],
  bob: [],
};

const resolveToken: TokenResolver = async (token) =>
  token === 'alice' || token === 'bob'
    ? { tenantId, userId: token as UserId, scopes: [], capabilities: [] }
    : null;

function memoryBlobs(): BlobStorageBinding & { readonly rows: Map<string, BlobMeta> } {
  const rows = new Map<string, BlobMeta>();
  const bytes = new Map<string, Uint8Array>();
  const read = async (b: ReadableStream<Uint8Array> | Uint8Array) =>
    b instanceof Uint8Array ? b : new Uint8Array(await new Response(b).arrayBuffer());
  const binding: Pick<BlobStorageBinding, 'put' | 'get' | 'head' | 'list' | 'delete'> = {
    async put(_t, input) {
      const blobId = randomUUID() as ArtifactId;
      const body = await read(input.bytes);
      const meta: BlobMeta = {
        blobId,
        tenantId,
        name: input.name,
        contentType: input.contentType,
        size: body.byteLength,
        hash: '0'.repeat(64),
        tags: input.tags ?? {},
        ...(input.ownerRunId !== undefined && { ownerRunId: input.ownerRunId }),
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        createdAt: '2026-10-07T00:00:00.000Z' as Timestamp,
      };
      rows.set(blobId, meta);
      bytes.set(blobId, body);
      return { kind: 'ok', value: meta };
    },
    async head(_t, id) {
      return rows.get(id) ?? null;
    },
    async get(_t, id) {
      const meta = rows.get(id);
      if (meta === undefined) {
        return { kind: 'err', error: { code: 'blob-not-found', message: 'none', blobId: id } };
      }
      return { kind: 'ok', value: { meta, stream: new Response(bytes.get(id)).body! } };
    },
    async list(_t, filter) {
      const data = [...rows.values()].filter(
        (m) =>
          (filter.scope?.kind !== 'project' || m.projectId === filter.scope.projectId) &&
          (filter.ownerRunId === undefined || m.ownerRunId === filter.ownerRunId),
      );
      return { kind: 'ok', value: { data } };
    },
    async delete(_t, id) {
      return { kind: 'ok', value: { deleted: rows.delete(id) } };
    },
  };
  return Object.assign(binding as BlobStorageBinding, { rows });
}

function decision(user: string, action: Action, resource: ResourceRef): Decision {
  const allowed = (GRANTS[user] ?? []).includes(`${action}:${resource.type}:${resource.id}`);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: no grant',
    evidence: { action, relation: '', resource: resource.id, actorSubject: user },
  };
}

function harness(options: { authz?: boolean; maxBytes?: number } = {}) {
  const stubs = createStubAppBindings();
  const blobs = memoryBlobs();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) =>
      id === RUN_IN_P2 ? { runId: id, projectId: P2 as ProjectId } : null,
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    projectBinding: {
      getDefault: async () => ({ id: P1 as ProjectId }),
    } as never,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    blobStorage: blobs,
    ...(options.maxBytes !== undefined && { artifactMaxBytes: options.maxBytes }),
    ...(options.authz !== false && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (p, action, resource) => decision(p.actor.id, action, resource),
          checkBatch: async (p, action, resources) =>
            resources.map((r) => decision(p.actor.id, action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const upload = async (as: string, fields: Record<string, string> = {}, body = 'hello') => {
    const form = new FormData();
    form.set('file', new Blob([body], { type: 'text/plain' }), 'note.txt');
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const res = await app.request('/v1/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${as}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const call = async (as: string, method: string, path: string) => {
    const res = await app.request(path, { method, headers: { authorization: `Bearer ${as}` } });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as Record<string, any> };
  };
  return { upload, call, blobs };
}

describe('artifacts belong to a project', () => {
  test('an upload naming nothing lands in the default project, made by the caller', async () => {
    const h = harness();
    const r = await h.upload('alice');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ projectId: P1, createdBy: 'user:alice', name: 'note.txt' });
  });

  test("an owner run's project wins; a projectId that disagrees, or an unknown run, is refused", async () => {
    const h = harness();
    // Alice can't write P2, the run's project.
    const denied = await h.upload('alice', { ownerRunId: RUN_IN_P2 });
    expect([denied.status, denied.body.error.code]).toEqual([403, 'permission-denied']);
    const mismatch = await h.upload('alice', { ownerRunId: RUN_IN_P2, projectId: P1 });
    expect([mismatch.status, mismatch.body.error.code]).toEqual([400, 'bad-input']);
    const unknown = await h.upload('alice', {
      ownerRunId: '00000000-0000-4000-8000-0000000000ff',
    });
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'run-not-found']);
    expect(h.blobs.rows.size).toBe(0);
  });

  test('an upload to a project the caller can only read is refused', async () => {
    const h = harness();
    const r = await h.upload('alice', { projectId: P2 });
    expect([r.status, r.body.error.code]).toEqual([403, 'permission-denied']);
  });
});

describe('reading and deleting', () => {
  async function seeded() {
    const h = harness({ authz: false });
    const inP1 = (await h.upload('alice', { projectId: P1 })).body.blobId as string;
    const inP2 = (await h.upload('alice', { projectId: P2 })).body.blobId as string;
    // The same rows, now behind the checks.
    const checked = harness();
    for (const [id, meta] of h.blobs.rows) checked.blobs.rows.set(id, meta);
    return { h: checked, inP1, inP2, rows: h.blobs.rows };
  }

  test('download needs read: anyone else gets 404, as if absent (HEAD too)', async () => {
    const { h, inP1, rows } = await seeded();
    // Bytes live in the first store; the checked store answers metadata.
    expect(rows.size).toBe(2);
    const bob = await h.call('bob', 'GET', `/v1/artifacts/${inP1}`);
    expect([bob.status, bob.json().error.code]).toEqual([404, 'blob-not-found']);
    expect((await h.call('bob', 'HEAD', `/v1/artifacts/${inP1}`)).status).toBe(404);
    expect((await h.call('alice', 'HEAD', `/v1/artifacts/${inP1}`)).status).toBe(200);
  });

  test('delete needs write: read-only is 403, no read is 404', async () => {
    const { h, inP1, inP2 } = await seeded();
    const readOnly = await h.call('alice', 'DELETE', `/v1/artifacts/${inP2}`);
    expect([readOnly.status, readOnly.json().error.code]).toEqual([403, 'permission-denied']);
    const none = await h.call('bob', 'DELETE', `/v1/artifacts/${inP1}`);
    expect(none.status).toBe(404);
    const ok = await h.call('alice', 'DELETE', `/v1/artifacts/${inP1}`);
    expect([ok.status, ok.json()]).toEqual([200, { blobId: inP1, deleted: true }]);
  });

  test('a list shows only what the caller can read; ?projectId narrows it', async () => {
    const { h } = await seeded();
    const alice = await h.call('alice', 'GET', '/v1/artifacts');
    expect(
      alice
        .json()
        .data.map((m: BlobMeta) => m.projectId)
        .sort(),
    ).toEqual([P1, P2]);
    const bob = await h.call('bob', 'GET', '/v1/artifacts');
    expect(bob.json().data).toEqual([]);
    const narrowed = await h.call('alice', 'GET', `/v1/artifacts?projectId=${P2}`);
    expect(narrowed.json().data.map((m: BlobMeta) => m.projectId)).toEqual([P2]);
  });
});

describe('the upload cap', () => {
  test('over the cap is 413 artifact-too-large, saying how much is allowed', async () => {
    // The cap counts the whole request body, multipart framing included.
    const h = harness({ maxBytes: 1024 });
    const r = await h.upload('alice', {}, 'x'.repeat(2000));
    expect([r.status, r.body.error.code, r.body.error.details.maxBytes]).toEqual([
      413,
      'artifact-too-large',
      1024,
    ]);
    expect(h.blobs.rows.size).toBe(0);
    expect((await h.upload('alice', {}, 'small')).status).toBe(201);
  });

  test('without authorization the routes work as before', async () => {
    const h = harness({ authz: false });
    const r = await h.upload('bob', { projectId: P2 });
    expect(r.status).toBe(201);
    expect((await h.call('bob', 'GET', `/v1/artifacts/${r.body.blobId}`)).text).toBe('hello');
  });
});
