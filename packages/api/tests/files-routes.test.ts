// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/v1/files` over an in-memory file store: a file belongs to a project
 * as an artifact does, reads need `read` there and changes `write`, a
 * version is read by its number or `latest`, and an upload over the cap
 * is `413 file-too-large` on both upload routes.
 */

import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type {
  FileError,
  FilePinChange,
  FileVersion,
  FileVersionSelector,
  FileVersionsBinding,
  StoredFile,
} from '@kindgi/blob-binding';
import type { RunBinding } from '@kindgi/runtime';
import type {
  ArtifactId,
  FileId,
  ProjectId,
  Result,
  RunId,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { validateAgainst } from './support/openapi-schema.js';

const tenantId = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000b1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const RUN_IN_P2 = '00000000-0000-4000-8000-0000000000c2';
/** Everyone in the workspace may run P3: `run` there, and no `read`. */
const P3 = '00000000-0000-4000-8000-0000000000b3';
/** Runs in P3 that act for Carol and for Dave. */
const CAROLS_RUN = '00000000-0000-4000-8000-0000000000c3';
const DAVES_RUN = '00000000-0000-4000-8000-0000000000c4';
const RUNS: Readonly<Record<string, { readonly projectId: string; readonly actsFor?: string }>> = {
  [RUN_IN_P2]: { projectId: P2 },
  [CAROLS_RUN]: { projectId: P3, actsFor: 'user:carol' },
  [DAVES_RUN]: { projectId: P3, actsFor: 'user:dave' },
};
const ABSENT = '00000000-0000-4000-8000-0000000000ee';

/** A service account's key, and the account's id. */
const ACCOUNT = 'sa-ci';

/**
 * Alice reads and writes P1 and reads P2; Bob has nothing; Carol, and the
 * service account, may only run P3.
 */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  alice: [`read:project:${P1}`, `write:project:${P1}`, `read:project:${P2}`],
  bob: [],
  carol: [`run:project:${P3}`],
  [ACCOUNT]: [`run:project:${P3}`],
};

/** `alice-key-p1` is alice with an API key limited to project P1. */
const resolveToken: TokenResolver = async (token) =>
  token === 'alice' || token === 'bob' || token === 'carol'
    ? { tenantId, userId: token as UserId, scopes: [], capabilities: [] }
    : token === 'alice-key-p1'
      ? { tenantId, userId: 'alice' as UserId, scopes: [], capabilities: [], tokenProjectId: P1 }
      : token === ACCOUNT
        ? { tenantId, serviceAccountId: ACCOUNT, scopes: [], capabilities: [] }
        : null;

interface MemoryFile {
  readonly fileId: FileId;
  readonly projectId?: ProjectId;
  readonly createdBy?: string;
  readonly ownerRunId?: RunId;
  readonly createdAt: Timestamp;
  readonly versions: Map<number, FileVersion>;
  readonly bytes: Map<number, Uint8Array>;
  readonly pins: FilePinChange[];
  deleted: boolean;
}

/**
 * The store's rules as `FileVersionsBinding` states them, kept small:
 * Latest is the highest live version, same bytes as Latest add none, a
 * pinned version and a file's last live one aren't deleted.
 */
function memoryFiles(): FileVersionsBinding & {
  readonly files: Map<string, MemoryFile>;
  /** Each version's bytes `readVersion` opened, as `<fileId>@<version>`. */
  readonly opened: string[];
} {
  const files = new Map<string, MemoryFile>();
  const opened: string[] = [];
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 5, 0, 0, tick++)).toISOString() as Timestamp;
  const read = async (b: ReadableStream<Uint8Array> | Uint8Array) =>
    b instanceof Uint8Array ? b : new Uint8Array(await new Response(b).arrayBuffer());
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const err = <T>(error: FileError): Result<T, FileError> => ({ kind: 'err', error });
  const notFound = (fileId: string) =>
    err<never>({ code: 'file-not-found', message: 'none', fileId });
  const noVersion = (fileId: string, version: FileVersionSelector) =>
    err<never>({ code: 'file-version-not-found', message: 'none', fileId, version });
  const live = (f: MemoryFile) => [...f.versions.values()].filter((v) => v.deletedAt === undefined);
  const latestOf = (f: MemoryFile) => live(f).reduce((a, b) => (b.version > a.version ? b : a));
  const stored = (f: MemoryFile): StoredFile => {
    const latest = latestOf(f);
    return {
      fileId: f.fileId,
      tenantId,
      ...(f.projectId !== undefined && { projectId: f.projectId }),
      name: latest.name,
      ...(f.createdBy !== undefined && { createdBy: f.createdBy }),
      ...(f.ownerRunId !== undefined && { ownerRunId: f.ownerRunId }),
      latestVersion: latest.version,
      highestVersion: Math.max(...f.versions.keys()),
      pinnedVersions: [...f.versions.values()]
        .filter((v) => v.pin !== undefined)
        .map((v) => v.version)
        .sort((a, b) => a - b),
      latest,
      createdAt: f.createdAt,
      updatedAt: latest.createdAt,
    };
  };
  const found = (fileId: string) => {
    const f = files.get(fileId);
    return f === undefined || f.deleted ? undefined : f;
  };
  const pick = (f: MemoryFile, version: FileVersionSelector) =>
    version === 'latest' ? latestOf(f) : f.versions.get(version);
  /** A new highest version, Latest its parent; same bytes as Latest make none. */
  const append = (
    f: MemoryFile,
    body: Uint8Array,
    fields: Omit<FileVersion, 'fileId' | 'version' | 'blobId' | 'size' | 'hash' | 'createdAt'>,
    expectedVersion: number | undefined,
  ) => {
    const latest = latestOf(f);
    if (expectedVersion !== undefined && expectedVersion !== latest.version) {
      return err<never>({
        code: 'file-version-conflict',
        message: 'stale',
        fileId: f.fileId,
        expectedVersion,
        latestVersion: latest.version,
      });
    }
    const hash = sha(body);
    if (hash === latest.hash) {
      return { kind: 'ok' as const, value: { version: latest, created: false } };
    }
    const highest = Math.max(...f.versions.keys());
    const at = now();
    const previous = f.versions.get(highest);
    if (previous !== undefined) f.versions.set(highest, { ...previous, supersededAt: at });
    const version: FileVersion = {
      ...fields,
      fileId: f.fileId,
      version: highest + 1,
      blobId: randomUUID() as ArtifactId,
      size: body.byteLength,
      hash,
      parentVersion: latest.version,
      createdAt: at,
    };
    f.versions.set(version.version, version);
    f.bytes.set(version.version, body);
    return { kind: 'ok' as const, value: { version, created: true } };
  };
  const pinChange = (
    fileId: string,
    version: number,
    change: 'pin' | 'unpin',
    input: { by: string; reason?: string },
  ) => {
    const f = found(fileId);
    if (f === undefined) return notFound(fileId);
    const v = f.versions.get(version);
    if (v === undefined || v.deletedAt !== undefined) return noVersion(fileId, version);
    if ((change === 'pin') === (v.pin !== undefined)) return { kind: 'ok' as const, value: v };
    const at = now();
    const { pin: _was, ...rest } = v;
    const next: FileVersion =
      change === 'pin'
        ? {
            ...rest,
            pin: { by: input.by, at, ...(input.reason !== undefined && { reason: input.reason }) },
          }
        : rest;
    f.versions.set(version, next);
    f.pins.push({
      changeId: randomUUID(),
      fileId: f.fileId,
      version,
      change,
      by: input.by,
      at,
      ...(input.reason !== undefined && { reason: input.reason }),
    });
    return { kind: 'ok' as const, value: next };
  };

  const binding: FileVersionsBinding = {
    async create(_t, input) {
      const body = await read(input.bytes);
      const fileId = randomUUID() as FileId;
      const at = now();
      const version: FileVersion = {
        fileId,
        version: 1,
        blobId: fileId as unknown as ArtifactId,
        name: input.name,
        contentType: input.contentType,
        size: body.byteLength,
        hash: sha(body),
        tags: input.tags ?? {},
        madeVia: input.madeVia ?? 'upload',
        ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        createdAt: at,
      };
      files.set(fileId, {
        fileId,
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        ...(input.ownerRunId !== undefined && { ownerRunId: input.ownerRunId }),
        createdAt: at,
        versions: new Map([[1, version]]),
        bytes: new Map([[1, body]]),
        pins: [],
        deleted: false,
      });
      return { kind: 'ok', value: { version, created: true } };
    },
    async get(_t, fileId) {
      const f = found(fileId);
      return f === undefined ? null : stored(f);
    },
    async list(_t, filter) {
      const data = [...files.values()]
        .filter((f) => !f.deleted)
        .map(stored)
        .filter(
          (f) =>
            (filter.scope?.kind !== 'project' || f.projectId === filter.scope.projectId) &&
            (filter.ownerRunId === undefined || f.ownerRunId === filter.ownerRunId) &&
            (filter.contentType === undefined || f.latest.contentType === filter.contentType),
        );
      return { kind: 'ok', value: { data } };
    },
    async delete(_t, fileId) {
      const f = files.get(fileId);
      if (f === undefined) return notFound(fileId);
      const pinned = stored(f).pinnedVersions[0];
      if (!f.deleted && pinned !== undefined) {
        return err({ code: 'file-version-pinned', message: 'pinned', fileId, version: pinned });
      }
      const was = f.deleted;
      f.deleted = true;
      return { kind: 'ok', value: { deleted: !was } };
    },
    async listVersions(_t, fileId) {
      const f = found(fileId);
      if (f === undefined) return notFound(fileId);
      const data = [...f.versions.values()].sort((a, b) => b.version - a.version);
      return { kind: 'ok', value: { data } };
    },
    async getVersion(_t, fileId, version) {
      const f = found(fileId);
      if (f === undefined) return notFound(fileId);
      const v = pick(f, version);
      return v === undefined ? noVersion(fileId, version) : { kind: 'ok', value: v };
    },
    async readVersion(_t, fileId, version) {
      const f = found(fileId);
      if (f === undefined) return notFound(fileId);
      const v = pick(f, version);
      if (v === undefined || v.deletedAt !== undefined || v.purgedAt !== undefined) {
        return noVersion(fileId, version);
      }
      opened.push(`${fileId}@${v.version}`);
      return {
        kind: 'ok',
        value: { version: v, stream: new Response(f.bytes.get(v.version)).body! },
      };
    },
    async addVersion(_t, fileId, input) {
      const f = found(fileId);
      if (f === undefined) return notFound(fileId);
      const body = await read(input.bytes);
      return append(
        f,
        body,
        {
          name: input.name ?? latestOf(f).name,
          contentType: input.contentType,
          tags: input.tags ?? {},
          madeVia: input.madeVia ?? 'upload',
          ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        },
        input.expectedVersion,
      );
    },
    async restoreVersion(_t, fileId, version, input) {
      const f = found(fileId);
      if (f === undefined) return notFound(fileId);
      const source = f.versions.get(version);
      const body = f.bytes.get(version);
      if (source === undefined || source.deletedAt !== undefined || body === undefined) {
        return noVersion(fileId, version);
      }
      return append(
        f,
        body,
        {
          name: latestOf(f).name,
          contentType: source.contentType,
          tags: source.tags,
          restoredFrom: version,
          madeVia: 'restore',
          ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        },
        input.expectedVersion,
      );
    },
    async deleteVersion(_t, fileId, version) {
      const f = found(fileId);
      if (f === undefined) return notFound(fileId);
      const v = f.versions.get(version);
      if (v === undefined) return noVersion(fileId, version);
      if (v.deletedAt !== undefined) return { kind: 'ok', value: { deleted: false } };
      if (v.pin !== undefined) {
        return err({ code: 'file-version-pinned', message: 'pinned', fileId, version });
      }
      if (live(f).length === 1) {
        return err({ code: 'file-last-version', message: 'last', fileId, version });
      }
      f.versions.set(version, { ...v, deletedAt: now() });
      return { kind: 'ok', value: { deleted: true } };
    },
    async pinVersion(_t, fileId, version, input) {
      return pinChange(fileId, version, 'pin', input);
    },
    async unpinVersion(_t, fileId, version, input) {
      return pinChange(fileId, version, 'unpin', input);
    },
    async pinHistory(_t, fileId) {
      const f = found(fileId);
      if (f === undefined) return notFound(fileId);
      return { kind: 'ok', value: { data: [...f.pins].reverse() } };
    },
  };
  return Object.assign(binding, { files, opened });
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
  const store = memoryFiles();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, id: RunId) => {
      const found = RUNS[id];
      return found === undefined ? null : { runId: id, ...found };
    },
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    projectBinding: { getDefault: async () => ({ id: P1 as ProjectId }) } as never,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    fileVersions: store,
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
  /** A multipart upload: a new file, or with `fileId` a new version of it. */
  const upload = async (
    as: string,
    options: {
      readonly fileId?: string;
      readonly fields?: Record<string, string>;
      readonly body?: string;
      readonly filename?: string;
    } = {},
  ) => {
    const form = new FormData();
    form.set(
      'file',
      new Blob([options.body ?? 'hello'], { type: 'text/plain' }),
      options.filename ?? 'note.txt',
    );
    for (const [k, v] of Object.entries(options.fields ?? {})) form.set(k, v);
    const path =
      options.fileId === undefined ? '/v1/files' : `/v1/files/${options.fileId}/versions`;
    const res = await app.request(path, {
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
    options: { readonly headers?: Record<string, string>; readonly json?: unknown } = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${as}`,
        ...(options.json !== undefined && { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.json !== undefined && { body: JSON.stringify(options.json) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      text,
      json: () => JSON.parse(text) as Record<string, any>,
    };
  };
  /** A new file in `projectId`, as alice; its id. */
  const seed = async (projectId: string, body = 'v1') => {
    const made = await store.create(tenantId, {
      name: 'note.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode(body),
      projectId: projectId as ProjectId,
      createdBy: 'user:alice',
    });
    if (made.kind === 'err') throw new Error(made.error.message);
    return made.value.version.fileId as string;
  };
  return { upload, call, seed, store };
}

describe('a new file', () => {
  test('lands in the default project, made by the caller: version 1, created', async () => {
    const h = harness();
    const r = await h.upload('alice');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(validateAgainst('FileVersionWrite', r.body)).toEqual([]);
    expect(r.body).toMatchObject({
      created: true,
      version: { version: 1, name: 'note.txt', madeVia: 'upload', createdBy: 'user:alice' },
    });
    const fileId = r.body.version.fileId as string;
    const got = await h.call('alice', 'GET', `/v1/files/${fileId}`);
    expect(validateAgainst('StoredFile', got.json())).toEqual([]);
    expect(got.json()).toMatchObject({ fileId, projectId: P1, latestVersion: 1, name: 'note.txt' });
  });

  test('a project the caller can only read is refused, and nothing is stored', async () => {
    const h = harness();
    const r = await h.upload('alice', { fields: { projectId: P2 } });
    expect([r.status, r.body.error.code]).toEqual([403, 'permission-denied']);
    expect(h.store.files.size).toBe(0);
  });

  test('a key limited to a project: another project, named or through an owner run, is refused', async () => {
    const h = harness();
    expect((await h.upload('alice-key-p1', { fields: { projectId: P1 } })).status).toBe(201);
    for (const fields of [{ projectId: P2 }, { ownerRunId: RUN_IN_P2 }]) {
      const r = await h.upload('alice-key-p1', { fields });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({
        code: 'key-project-mismatch',
        details: { keyProjectId: P1, projectId: P2 },
      });
    }
    expect(h.store.files.size).toBe(1);
  });
});

describe('adding a version', () => {
  test("new bytes are Latest + 1, with Latest as parent; Latest's own bytes add none (200)", async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    const added = await h.upload('alice', { fileId, body: 'v2' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(validateAgainst('FileVersionWrite', added.body)).toEqual([]);
    expect(added.body.version).toMatchObject({
      version: 2,
      parentVersion: 1,
      createdBy: 'user:alice',
    });
    const again = await h.upload('alice', { fileId, body: 'v2' });
    expect([again.status, again.body.created, again.body.version.version]).toEqual([200, false, 2]);
  });

  test('a stale expectedVersion is 409 file-version-conflict, and nothing is written', async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    await h.upload('alice', { fileId, body: 'v2' });
    const stale = await h.upload('alice', { fileId, body: 'v3', fields: { expectedVersion: '1' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'file-version-conflict',
      details: { expectedVersion: 1, latestVersion: 2 },
    });
    const fresh = await h.upload('alice', { fileId, body: 'v3', fields: { expectedVersion: '2' } });
    expect([fresh.status, fresh.body.version.version]).toEqual([201, 3]);
    for (const bad of ['0', 'two', '1.5']) {
      const r = await h.upload('alice', { fileId, body: 'v4', fields: { expectedVersion: bad } });
      expect([bad, r.status, r.body.error.code]).toEqual([bad, 400, 'bad-input']);
    }
  });

  test("the form's name renames the file; the file part's own filename doesn't", async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    const kept = await h.upload('alice', { fileId, body: 'v2', filename: 'other.txt' });
    expect(kept.body.version.name).toBe('note.txt');
    const renamed = await h.upload('alice', { fileId, body: 'v3', fields: { name: 'final.txt' } });
    expect(renamed.body.version.name).toBe('final.txt');
    expect((await h.call('alice', 'GET', `/v1/files/${fileId}`)).json().name).toBe('final.txt');
  });

  test("a version stays in its file's project: ownerRunId or projectId is bad input", async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    for (const fields of [{ projectId: P1 }, { ownerRunId: CAROLS_RUN }]) {
      const r = await h.upload('alice', { fileId, body: 'v2', fields });
      expect([r.status, r.body.error.code]).toEqual([400, 'bad-input']);
    }
    expect(h.store.files.get(fileId)?.versions.size).toBe(1);
  });
});

describe('reading versions', () => {
  test('by number or `latest`; versions list newest first; a malformed version is 400', async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    await h.upload('alice', { fileId, body: 'v2' });
    const latest = await h.call('alice', 'GET', `/v1/files/${fileId}/versions/latest`);
    expect(validateAgainst('FileVersion', latest.json())).toEqual([]);
    expect(latest.json().version).toBe(2);
    expect((await h.call('alice', 'GET', `/v1/files/${fileId}/versions/1`)).json().version).toBe(1);
    const list = await h.call('alice', 'GET', `/v1/files/${fileId}/versions`);
    expect(validateAgainst('FileVersionCollectionPage', list.json())).toEqual([]);
    expect(list.json().data.map((v: FileVersion) => v.version)).toEqual([2, 1]);
    const missing = await h.call('alice', 'GET', `/v1/files/${fileId}/versions/9`);
    expect([missing.status, missing.json().error.code]).toEqual([404, 'file-version-not-found']);
    for (const bad of ['0', '01', '1.5', 'first', '-1']) {
      const r = await h.call('alice', 'GET', `/v1/files/${fileId}/versions/${bad}`);
      expect([bad, r.status]).toEqual([bad, 400]);
    }
  });

  test('restore, delete, pin and unpin take a number only: `latest`, 0, 1.5 or abc is 400', async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    for (const [method, tail] of [
      ['POST', 'restore'],
      ['DELETE', ''],
      ['POST', 'pin'],
      ['POST', 'unpin'],
    ] as const) {
      for (const bad of ['latest', '0', '1.5', 'abc']) {
        const path = `/v1/files/${fileId}/versions/${bad}${tail === '' ? '' : `/${tail}`}`;
        const r = await h.call('alice', method, path);
        expect([path, r.status, r.json().error.code]).toEqual([path, 400, 'bad-input']);
      }
    }
  });

  test('a download carries its version; a HEAD answers the same headers and never opens the bytes', async () => {
    const h = harness();
    const fileId = await h.seed(P1, 'the bytes');
    await h.upload('alice', { fileId, body: 'newer bytes' });
    for (const [selector, version, text] of [
      ['latest', '2', 'newer bytes'],
      ['1', '1', 'the bytes'],
    ] as const) {
      const path = `/v1/files/${fileId}/versions/${selector}/content`;
      const sent = { headers: { 'x-request-id': `req-${selector}` } };
      const head = await h.call('alice', 'HEAD', path, sent);
      expect(h.store.opened).toEqual([]);
      const get = await h.call('alice', 'GET', path, sent);
      expect(h.store.opened).toEqual([`${fileId}@${version}`]);
      expect([head.status, get.status, get.text, head.text]).toEqual([200, 200, text, '']);
      expect(get.headers['x-kindgi-file-version']).toBe(version);
      const { traceresponse: _headSpan, ...headHeaders } = head.headers;
      const { traceresponse: _getSpan, ...getHeaders } = get.headers;
      expect(headHeaders).toEqual(getHeaders);
      h.store.opened.length = 0;
    }
  });

  test("a deleted version's record still reads; its bytes are 404 file-version-not-found (HEAD too)", async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    await h.upload('alice', { fileId, body: 'v2' });
    const del = await h.call('alice', 'DELETE', `/v1/files/${fileId}/versions/1`);
    expect([del.status, del.json()]).toEqual([200, { fileId, version: 1, deleted: true }]);
    expect(validateAgainst('DeleteFileResult', del.json())).toEqual([]);
    const record = await h.call('alice', 'GET', `/v1/files/${fileId}/versions/1`);
    expect(record.json().deletedAt).toEqual(expect.any(String));
    const bytes = await h.call('alice', 'GET', `/v1/files/${fileId}/versions/1/content`);
    expect([bytes.status, bytes.json().error.code]).toEqual([404, 'file-version-not-found']);
    const head = await h.call('alice', 'HEAD', `/v1/files/${fileId}/versions/1/content`);
    expect(head.status).toBe(404);
    expect(h.store.opened).toEqual([]);
  });
});

describe('restore, pin and delete', () => {
  test("a restore is a new version from the old bytes, under Latest's name; a stale expectedVersion is 409", async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    await h.upload('alice', { fileId, body: 'v2', fields: { name: 'renamed.txt' } });
    const stale = await h.call('alice', 'POST', `/v1/files/${fileId}/versions/1/restore`, {
      json: { expectedVersion: 1 },
    });
    expect([stale.status, stale.json().error.code]).toEqual([409, 'file-version-conflict']);
    const restored = await h.call('alice', 'POST', `/v1/files/${fileId}/versions/1/restore`, {
      json: { expectedVersion: 2 },
    });
    expect(restored.status).toBe(201);
    expect(restored.json().version).toMatchObject({
      version: 3,
      restoredFrom: 1,
      madeVia: 'restore',
      name: 'renamed.txt',
      createdBy: 'user:alice',
    });
    // No body at all is fine: the last write wins.
    const bare = await h.call('alice', 'POST', `/v1/files/${fileId}/versions/2/restore`);
    expect([bare.status, bare.json().version.version]).toEqual([201, 4]);
    for (const json of [{ expectedVersion: 'x' }, { expectedVersion: 0 }, [1]]) {
      const r = await h.call('alice', 'POST', `/v1/files/${fileId}/versions/1/restore`, { json });
      expect([r.status, r.json().error.code]).toEqual([400, 'bad-input']);
    }
  });

  test('a pinned version is kept: neither it nor its file is deleted; the pin history names each change', async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    await h.upload('alice', { fileId, body: 'v2' });
    const pinned = await h.call('alice', 'POST', `/v1/files/${fileId}/versions/1/pin`, {
      json: { reason: 'signed copy' },
    });
    expect(pinned.status).toBe(200);
    expect(pinned.json().pin).toMatchObject({ by: 'user:alice', reason: 'signed copy' });
    const one = await h.call('alice', 'DELETE', `/v1/files/${fileId}/versions/1`);
    expect([one.status, one.json().error.code]).toEqual([409, 'file-version-pinned']);
    const all = await h.call('alice', 'DELETE', `/v1/files/${fileId}`);
    expect([all.status, all.json().error.code]).toEqual([409, 'file-version-pinned']);
    expect((await h.call('alice', 'GET', `/v1/files/${fileId}`)).json().pinnedVersions).toEqual([
      1,
    ]);
    await h.call('alice', 'POST', `/v1/files/${fileId}/versions/1/unpin`);
    const history = await h.call('alice', 'GET', `/v1/files/${fileId}/pin-history`);
    expect(validateAgainst('FilePinChangeCollectionPage', history.json())).toEqual([]);
    expect(history.json().data.map((p: FilePinChange) => p.change)).toEqual(['unpin', 'pin']);
    const long = await h.call('alice', 'POST', `/v1/files/${fileId}/versions/1/pin`, {
      json: { reason: 'x'.repeat(501) },
    });
    expect([long.status, long.json().error.code]).toEqual([400, 'bad-input']);
    const gone = await h.call('alice', 'DELETE', `/v1/files/${fileId}`);
    expect([gone.status, gone.json()]).toEqual([200, { fileId, deleted: true }]);
    expect((await h.call('alice', 'GET', `/v1/files/${fileId}`)).status).toBe(404);
  });

  test("a file's last live version goes only with the file: 409 file-last-version", async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    const r = await h.call('alice', 'DELETE', `/v1/files/${fileId}/versions/1`);
    expect([r.status, r.json().error.code]).toEqual([409, 'file-last-version']);
  });

  test('a deleted version is neither restored nor pinned: 404 file-version-not-found', async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    await h.upload('alice', { fileId, body: 'v2' });
    await h.call('alice', 'DELETE', `/v1/files/${fileId}/versions/1`);
    for (const op of ['restore', 'pin']) {
      const r = await h.call('alice', 'POST', `/v1/files/${fileId}/versions/1/${op}`);
      expect([op, r.status, r.json().error.code]).toEqual([op, 404, 'file-version-not-found']);
    }
    expect((await h.call('alice', 'GET', `/v1/files/${fileId}`)).json().latestVersion).toBe(2);
  });

  test('deleting a file twice is 200 `{ deleted: false }` the second time; an unknown one is 404', async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    const first = await h.call('alice', 'DELETE', `/v1/files/${fileId}`);
    expect([first.status, first.json()]).toEqual([200, { fileId, deleted: true }]);
    const record = h.store.files.get(fileId)!;
    const before = structuredClone({ ...record });
    const again = await h.call('alice', 'DELETE', `/v1/files/${fileId}`);
    expect([again.status, again.json()]).toEqual([200, { fileId, deleted: false }]);
    expect(validateAgainst('DeleteFileResult', again.json())).toEqual([]);
    // The second delete changes nothing: no version, byte or pin.
    expect({ ...record }).toEqual(before);
    const unknown = await h.call('alice', 'DELETE', `/v1/files/${ABSENT}`);
    expect([unknown.status, unknown.json().error.code]).toEqual([404, 'file-not-found']);
  });
});

describe('who may read and change a file', () => {
  test('reads need read: anyone else gets 404, as if absent', async () => {
    const h = harness();
    const fileId = await h.seed(P1);
    for (const path of [
      `/v1/files/${fileId}`,
      `/v1/files/${fileId}/versions`,
      `/v1/files/${fileId}/versions/1`,
      `/v1/files/${fileId}/versions/1/content`,
      `/v1/files/${fileId}/pin-history`,
      `/v1/files/${ABSENT}`,
    ]) {
      const r = await h.call('bob', 'GET', path);
      expect([path, r.status, r.json().error.code]).toEqual([path, 404, 'file-not-found']);
    }
    expect((await h.call('bob', 'HEAD', `/v1/files/${fileId}/versions/1/content`)).status).toBe(
      404,
    );
  });

  test('changes need write: read-only is 403, no read is 404, and nothing changes', async () => {
    const h = harness();
    const inP2 = await h.seed(P2);
    const readOnly = [
      await h.upload('alice', { fileId: inP2, body: 'v2' }),
      await h.call('alice', 'POST', `/v1/files/${inP2}/versions/1/pin`).then((r) => ({
        status: r.status,
        body: r.json(),
      })),
      await h.call('alice', 'DELETE', `/v1/files/${inP2}`).then((r) => ({
        status: r.status,
        body: r.json(),
      })),
    ];
    for (const r of readOnly) {
      expect([r.status, r.body.error.code]).toEqual([403, 'permission-denied']);
    }
    const bob = await h.call('bob', 'DELETE', `/v1/files/${inP2}`);
    expect([bob.status, bob.json().error.code]).toEqual([404, 'file-not-found']);
    const f = h.store.files.get(inP2);
    expect([f?.versions.size, f?.pins.length, f?.deleted]).toEqual([1, 0, false]);
  });

  test('a list shows only what the caller can read; ?projectId and ?contentType narrow it', async () => {
    const h = harness();
    const inP1 = await h.seed(P1);
    const inP2 = await h.seed(P2);
    await h.seed(P3);
    const all = await h.call('alice', 'GET', '/v1/files');
    expect(validateAgainst('StoredFileCollectionPage', all.json())).toEqual([]);
    expect(new Set(all.json().data.map((f: StoredFile) => f.fileId))).toEqual(
      new Set([inP1, inP2]),
    );
    const p2 = await h.call('alice', 'GET', `/v1/files?projectId=${P2}`);
    expect(p2.json().data.map((f: StoredFile) => f.fileId)).toEqual([inP2]);
    const json = await h.call('alice', 'GET', '/v1/files?contentType=application/json');
    expect(json.json().data).toEqual([]);
    expect((await h.call('bob', 'GET', '/v1/files')).json().data).toEqual([]);
  });

  test('without authorization the routes work as before', async () => {
    const h = harness({ authz: false });
    const r = await h.upload('bob', { fields: { projectId: P2 } });
    expect(r.status).toBe(201);
    const path = `/v1/files/${r.body.version.fileId}/versions/latest/content`;
    expect((await h.call('bob', 'GET', path)).text).toBe('hello');
  });
});

describe('someone who may only run the project reaches their own files', () => {
  test('she reads a file she made and one her run made; not one of another person', async () => {
    const h = harness();
    const mine = await h.store.create(tenantId, {
      name: 'mine.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('hers'),
      projectId: P3 as ProjectId,
      createdBy: 'user:carol',
    });
    const runs = await h.store.create(tenantId, {
      name: 'run.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('her run'),
      projectId: P3 as ProjectId,
      ownerRunId: CAROLS_RUN as RunId,
    });
    const daves = await h.store.create(tenantId, {
      name: 'dave.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('daves'),
      projectId: P3 as ProjectId,
      ownerRunId: DAVES_RUN as RunId,
    });
    if (mine.kind === 'err' || runs.kind === 'err' || daves.kind === 'err') throw new Error('seed');
    for (const made of [mine.value, runs.value]) {
      const path = `/v1/files/${made.version.fileId}/versions/latest/content`;
      expect((await h.call('carol', 'GET', path)).status).toBe(200);
    }
    const other = await h.call('carol', 'GET', `/v1/files/${daves.value.version.fileId}`);
    expect([other.status, other.json().error.code]).toEqual([404, 'file-not-found']);
    const own = await h.call('carol', 'GET', `/v1/files?ownerRunId=${CAROLS_RUN}`);
    expect(own.json().data.map((f: StoredFile) => f.fileId)).toEqual([runs.value.version.fileId]);
    expect((await h.call('carol', 'GET', `/v1/files?ownerRunId=${DAVES_RUN}`)).json().data).toEqual(
      [],
    );
  });

  test('she makes an input that names no run, and adds no version to it: 403', async () => {
    const h = harness();
    const input = await h.upload('carol', { fields: { projectId: P3 } });
    expect(input.status, JSON.stringify(input.body)).toBe(201);
    const fileId = input.body.version.fileId as string;
    const intoRun = await h.upload('carol', { fields: { ownerRunId: CAROLS_RUN } });
    expect([intoRun.status, intoRun.body.error.code]).toEqual([403, 'permission-denied']);
    const added = await h.upload('carol', { fileId, body: 'v2' });
    expect([added.status, added.body.error.code]).toEqual([403, 'permission-denied']);
    expect(h.store.files.size).toBe(1);
  });

  test('a service account that may only run it makes no input: 403, as on artifacts', async () => {
    const h = harness();
    const r = await h.upload(ACCOUNT, { fields: { projectId: P3 } });
    expect([r.status, r.body.error.code]).toEqual([403, 'permission-denied']);
    expect(h.store.files.size).toBe(0);
  });

  test('nor reads a file it made when it could write: 404, as if absent', async () => {
    const h = harness();
    const made = await h.store.create(tenantId, {
      name: 'ci.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('from ci'),
      projectId: P3 as ProjectId,
      createdBy: `service_account:${ACCOUNT}`,
    });
    if (made.kind === 'err') throw new Error(made.error.message);
    const fileId = made.value.version.fileId as string;
    for (const path of [`/v1/files/${fileId}`, `/v1/files/${fileId}/versions/latest/content`]) {
      const r = await h.call(ACCOUNT, 'GET', path);
      expect([path, r.status, r.json().error.code]).toEqual([path, 404, 'file-not-found']);
    }
  });
});

describe('the upload cap', () => {
  test('over it is 413 file-too-large on both upload routes, saying how much is allowed', async () => {
    const h = harness({ maxBytes: 1024 });
    const fileId = await h.seed(P1);
    for (const target of [undefined, fileId]) {
      const r = await h.upload('alice', {
        ...(target !== undefined && { fileId: target }),
        body: 'x'.repeat(2000),
      });
      expect([r.status, r.body.error.code, r.body.error.details.maxBytes]).toEqual([
        413,
        'file-too-large',
        1024,
      ]);
    }
    expect(h.store.files.size).toBe(1);
    expect(h.store.files.get(fileId)?.versions.size).toBe(1);
  });
});
