// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/artifacts` over an in-memory blob store: every artifact belongs to
 * a project (its owner run's, else the upload's `projectId`, else the
 * default project), reads need `read` there and writes `write`, and an
 * upload over the cap is `413 artifact-too-large`.
 */

import { randomUUID } from 'node:crypto';

import { HOSTED_BOUNDS } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { BlobMeta, BlobStorageBinding } from '@kindgi/blob-binding';
import type { RunBinding } from '@kindgi/runtime';
import type { ArtifactId, ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { validateAgainst } from './support/openapi-schema.js';

const tenantId = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000b1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const RUN_IN_P2 = '00000000-0000-4000-8000-0000000000c2';

/** Alice reads and writes P1 and reads P2; Bob has nothing. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  alice: [`read:project:${P1}`, `write:project:${P1}`, `read:project:${P2}`],
  bob: [],
};

/** `alice-key-p1` is alice with an API key limited to project P1. */
const resolveToken: TokenResolver = async (token) =>
  token === 'alice' || token === 'bob'
    ? { tenantId, userId: token as UserId, scopes: [], capabilities: [] }
    : token === 'alice-key-p1'
      ? { tenantId, userId: 'alice' as UserId, scopes: [], capabilities: [], tokenProjectId: P1 }
      : null;

/**
 * With `s3Address`, each upload gets an S3-compatible address, as a store
 * serving `/s3` gives it: bucket `artifacts`, the `blobId` as its key.
 */
function memoryBlobs(options: { s3Address?: boolean } = {}): BlobStorageBinding & {
  readonly rows: Map<string, BlobMeta>;
  readonly bytes: Map<string, Uint8Array>;
  /** Each blob `get` opened, by id. */
  readonly opened: string[];
} {
  const rows = new Map<string, BlobMeta>();
  const bytes = new Map<string, Uint8Array>();
  const opened: string[] = [];
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
        ...(options.s3Address === true && { bucket: 'artifacts', key: blobId }),
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
      opened.push(id);
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
  return Object.assign(binding as BlobStorageBinding, { rows, bytes, opened });
}

function decision(user: string, action: Action, resource: ResourceRef): Decision {
  const allowed = (GRANTS[user] ?? []).includes(`${action}:${resource.type}:${resource.id}`);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: no grant',
    evidence: { action, relation: '', resource: resource.id, actorSubject: user },
  };
}

function harness(
  options: {
    authz?: boolean;
    maxBytes?: number;
    defaultProject?: string;
    s3Address?: boolean;
  } = {},
) {
  const stubs = createStubAppBindings();
  const blobs = memoryBlobs({ s3Address: options.s3Address === true });
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) =>
      id === RUN_IN_P2 ? { runId: id, projectId: P2 as ProjectId } : null,
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    projectBinding: {
      getDefault: async () => ({ id: (options.defaultProject ?? P1) as ProjectId }),
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
  const call = async (
    as: string,
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${as}`, ...headers },
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      text,
      json: () => JSON.parse(text) as Record<string, any>,
    };
  };
  /** A multipart body sent as the same bytes each time, as a client's retry sends it. */
  const sendBytes = async (as: string, sent: Request, headers: Record<string, string> = {}) => {
    const res = await app.request('/v1/artifacts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': sent.headers.get('content-type') ?? '',
        ...headers,
      },
      body: await sent.clone().arrayBuffer(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  /** A body sent as given (a stream included), multipart by its header. */
  const sendRaw = async (as: string, body: Uint8Array | ReadableStream<Uint8Array>) => {
    const res = await app.request('/v1/artifacts', {
      method: 'POST',
      headers: { authorization: `Bearer ${as}`, 'content-type': 'multipart/form-data; boundary=x' },
      body,
      ...(body instanceof ReadableStream && { duplex: 'half' }),
    } as RequestInit);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { upload, sendBytes, sendRaw, call, blobs };
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

describe("an artifact answer carries only BlobMeta's properties", () => {
  test('from a store that gives a blob an S3-compatible address, the upload and the list carry it', async () => {
    const h = harness({ s3Address: true });
    const up = await h.upload('alice');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ bucket: 'artifacts', key: up.body.blobId });
    expect(validateAgainst('BlobMeta', up.body)).toEqual([]);
    const list = (await h.call('alice', 'GET', '/v1/artifacts')).json();
    expect(list.data).toEqual([up.body]);
    expect(validateAgainst('ArtifactCollectionPage', list)).toEqual([]);
  });

  test('from a store that gives it none, the upload and the list leave it out', async () => {
    const h = harness();
    const up = await h.upload('alice');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).not.toHaveProperty('bucket');
    expect(up.body).not.toHaveProperty('key');
    expect(validateAgainst('BlobMeta', up.body)).toEqual([]);
    const list = (await h.call('alice', 'GET', '/v1/artifacts')).json();
    expect(list.data).toEqual([up.body]);
    expect(validateAgainst('ArtifactCollectionPage', list)).toEqual([]);
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

  test("a HEAD answers a GET's status and headers from the metadata, and never opens the blob", async () => {
    const h = harness();
    const blobId = (await h.upload('alice', { projectId: P1 }, 'the bytes')).body.blobId as string;
    const absent = '00000000-0000-4000-8000-0000000000ee';
    for (const [as, id, status] of [
      ['alice', blobId, 200],
      ['bob', blobId, 404],
      ['alice', absent, 404],
    ] as const) {
      const path = `/v1/artifacts/${id}`;
      const sent = { 'x-request-id': `req-${as}-${status}-${id}` };
      const head = await h.call(as, 'HEAD', path, sent);
      expect(h.blobs.opened, `HEAD ${as} ${id}`).toEqual([]);
      const get = await h.call(as, 'GET', path, sent);
      expect(h.blobs.opened, `GET ${as} ${id}`).toEqual(status === 200 ? [id] : []);
      // The one GET that opens the blob hands it out as the body.
      if (status === 200) expect(get.text).toBe('the bytes');
      expect([head.status, get.status]).toEqual([status, status]);
      // Each request answers its own span; every other header is the same.
      const { traceresponse: headSpan, ...headHeaders } = head.headers;
      const { traceresponse: getSpan, ...getHeaders } = get.headers;
      expect([headSpan, getSpan]).toEqual([expect.any(String), expect.any(String)]);
      expect(headHeaders, `${as} ${id}`).toEqual(getHeaders);
      expect(head.text).toBe('');
      h.blobs.opened.length = 0;
    }
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

describe('a download is saved as a file, never opened as a page of this origin', () => {
  const SAVED = {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  };

  test('GET and HEAD answer an attachment under its whole name, nosniff and sandboxed', async () => {
    const h = harness();
    const up = await h.upload('alice', {
      name: 'résumé (v2) "final".html',
      contentType: 'text/html; charset=utf-8',
    });
    for (const method of ['GET', 'HEAD']) {
      const res = await h.call('alice', method, `/v1/artifacts/${up.body.blobId}`);
      expect(res.status, method).toBe(200);
      expect(res.headers, method).toMatchObject({
        ...SAVED,
        'content-type': 'text/html; charset=utf-8',
        'content-disposition':
          'attachment; filename="r_sum_ (v2) _final_.html"; ' +
          "filename*=UTF-8''r%C3%A9sum%C3%A9%20%28v2%29%20%22final%22.html",
      });
    }
  });

  test.each([
    ['no subtype', 'html'],
    ['a list', 'text/html, image/png'],
    ['a line break', 'text/html\r\nx-other: 1'],
    ['a character outside ASCII', 'text/html; charset=ü'],
  ])('a stored type with %s is served as application/octet-stream', async (_what, stored) => {
    const h = harness();
    const blobId = (await h.upload('alice', { name: 'page.html' })).body.blobId as string;
    const meta = h.blobs.rows.get(blobId) as BlobMeta;
    h.blobs.rows.set(blobId, { ...meta, contentType: stored });
    for (const method of ['GET', 'HEAD']) {
      const res = await h.call('alice', method, `/v1/artifacts/${blobId}`);
      expect(res.status, method).toBe(200);
      expect(res.headers, method).toMatchObject({
        ...SAVED,
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="page.html"; filename*=UTF-8''page.html`,
      });
    }
  });
});

describe('an upload sent with an Idempotency-Key', () => {
  test('keeps its bytes as sent, and a repeat replays the first answer', async () => {
    const h = harness();
    const binary = new Uint8Array([0xff, 0x00, 0x80, 0xfe, 0x41]);
    const form = new FormData();
    form.set('file', new Blob([binary], { type: 'application/octet-stream' }), 'b.bin');
    const sent = new Request('http://localhost/', { method: 'POST', body: form });
    const key = { 'idempotency-key': 'upload-1' };
    const first = await h.sendBytes('alice', sent, key);
    expect(first.status).toBe(201);
    expect(h.blobs.bytes.get(first.body.blobId)).toEqual(binary);
    const again = await h.sendBytes('alice', sent, key);
    expect(again).toEqual(first);
    expect(h.blobs.rows.size).toBe(1);
  });
});

describe('a key limited to a project', () => {
  test("an upload naming nothing lands in the key's project, not the tenant's default", async () => {
    const h = harness({ defaultProject: P2 });
    const r = await h.upload('alice-key-p1');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ projectId: P1, createdBy: 'user:alice' });
  });

  test('its own project is fine; another, named or through an owner run, is refused', async () => {
    const h = harness();
    expect((await h.upload('alice-key-p1', { projectId: P1 })).status).toBe(201);
    for (const fields of [{ projectId: P2 }, { ownerRunId: RUN_IN_P2 }]) {
      const r = await h.upload('alice-key-p1', fields);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({
        code: 'key-project-mismatch',
        details: { keyProjectId: P1, projectId: P2 },
      });
    }
    expect(h.blobs.rows.size).toBe(1);
  });

  test('an upload sent again with its Idempotency-Key replays the first answer', async () => {
    const h = harness();
    const form = new FormData();
    form.set('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    const sent = new Request('http://localhost/', { method: 'POST', body: form });
    const key = { 'idempotency-key': 'upload-p1' };
    const first = await h.sendBytes('alice-key-p1', sent, key);
    expect(first.status).toBe(201);
    expect(await h.sendBytes('alice-key-p1', sent, key)).toEqual(first);
    expect(h.blobs.rows.size).toBe(1);
  });

  test('a JSON body labelled multipart is bad input, and nothing is stored', async () => {
    const h = harness();
    const json = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: JSON.stringify({ name: 'note.txt' }),
    });
    const r = await h.sendBytes('alice-key-p1', json);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'bad-input' });
    expect(h.blobs.rows.size).toBe(0);
  });
});

describe("an upload's body is never read as JSON", () => {
  const multipartBytes = (text: string) => new TextEncoder().encode(text);

  test('a JSON body over 2 MiB nested past the limit, labelled multipart, is the route’s to refuse', async () => {
    const restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    try {
      const deep = `${'['.repeat(129)}${' '.repeat(2 * 1024 * 1024)}${']'.repeat(129)}`;
      const r = await harness().sendRaw('alice', multipartBytes(deep));
      expect(r.status).toBe(400);
      expect(r.body.error).toEqual(
        expect.objectContaining({ code: 'bad-input', message: 'Malformed multipart body' }),
      );
      expect(r.body.error.details).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('a key limited to a project: a JSON body naming another project, labelled multipart, is the route’s to refuse', async () => {
    const h = harness();
    const r = await h.sendRaw('alice-key-p1', multipartBytes(JSON.stringify({ projectId: P2 })));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'bad-input', message: 'Malformed multipart body' });
    expect(h.blobs.rows.size).toBe(0);
  });
});

describe('the upload cap', () => {
  test("on hosted, an upload over the API's 2 MiB limit is under its own", async () => {
    const restore = overrideTenantInputBounds(HOSTED_BOUNDS);
    try {
      const r = await harness().upload('alice', {}, 'x'.repeat(3 * 1024 * 1024));
      expect(r.status).toBe(201);
    } finally {
      restore();
    }
  });

  test('a streamed upload is read no further than its cap', async () => {
    const h = harness({ maxBytes: 256 * 1024 });
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 10 * 1024 * 1024) return controller.close();
        pulled += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const r = await h.sendRaw('alice', stream);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatchObject({ code: 'artifact-too-large' });
    expect(pulled).toBeLessThanOrEqual(256 * 1024 + 2 * 64 * 1024);
  });

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
