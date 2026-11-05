// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type ResourceRef, ref } from '@kindgi/authz';
import type {
  FileError,
  FileFilter,
  FileVersion,
  FileVersionSelector,
  FileVersionWrite,
  FileVersionsBinding,
  StoredFile,
} from '@kindgi/blob-binding';
import type { ProjectBinding, Scope } from '@kindgi/platform';
import type { RunBinding } from '@kindgi/runtime';
import type { Cursor, FileId, ProjectId, RunId, TenantId } from '@kindgi/types';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { actsForOf, callerRef } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { databaseBusyAnswer } from '../middleware/error-mapper.js';
import { takeBody } from '../middleware/request-body.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';
import { clampLimit } from './pagination.js';
import { isOwnRun, readableOrRun } from './runner-reach.js';
import { savedFileHeaders } from './stored-bytes.js';
import { type ValidationResult, uploadProject, validateUploadForm } from './upload-form.js';

export interface FilesRouterDeps {
  /** Resolves a new file's owner run, and a file's, to tell whether it's the caller's own run. */
  readonly runBinding?: RunBinding;
  /** The tenant's default project, for a new file that names neither run nor project. */
  readonly projectBinding?: ProjectBinding;
  /**
   * Reads need `read` on the file's project; changes need `write`. `run`
   * there reaches a caller's own files, and a new file of their own for a
   * run's input (`filesRouter`).
   */
  readonly authorizer?: Authorizer;
}

/**
 * A file upload's size limit: more than `maxBytes` is `413
 * file-too-large`. The app checks it before the body is read, as
 * `artifactUploadLimit` does.
 */
export function fileUploadLimit(maxBytes: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) => {
      c.status(statusFor('file-too-large') as never);
      return c.json(
        toWireError(
          { code: 'file-too-large', message: `A file may be at most ${maxBytes} bytes`, maxBytes },
          c.get('requestId'),
        ),
      );
    },
  });
}

/**
 * The files routes over the caller-plugged `FileVersionsBinding` (from
 * `@kindgi/blob-binding`): files with every edit kept as a version.
 *
 * A file belongs to a project, as an artifact does: its owner run's, else
 * the upload's `projectId`, else the project the caller's API key is
 * limited to, else the tenant's default. With an authorizer, reads need
 * `read` there (a file the caller can't see is `404 file-not-found`, as
 * if absent), and every change needs `write`. `run` there is enough for
 * a caller's own files (`runner-reach.ts`): reading one they made or one
 * a run of their own made, listing an own run's files (`?ownerRunId=`),
 * and creating a file of their own that names no run, to start a run
 * with. Adding a version stays `write`, even to a file of their own.
 */
export function filesRouter(
  binding: FileVersionsBinding,
  deps: FilesRouterDeps = {},
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { authorizer } = deps;
  const tenantOf = (c: Context<AppEnv>) => c.get('tenantId') as TenantId;
  const scopeOf = (c: Context<AppEnv>, f: StoredFile): ResourceRef =>
    f.projectId !== undefined
      ? ref('project', f.projectId as unknown as string)
      : ref('tenant', c.get('tenantId') as unknown as string);
  const may = async (c: Context<AppEnv>, action: 'read' | 'write', f: StoredFile) =>
    authorizer === undefined || (await authorizer.can(c, action, scopeOf(c, f)));
  /** The run, when it's the caller's own (`isOwnRun`). */
  const ownRun = async (c: Context<AppEnv>, runId: RunId) => {
    const run =
      deps.runBinding === undefined ? null : await deps.runBinding.getRun(tenantOf(c), runId);
    return run !== null && isOwnRun(c, run) ? run : undefined;
  };
  /** A file of the caller's own: they made it, or a run of their own did. Decided by version 1. */
  const ownFile = async (c: Context<AppEnv>, f: StoredFile) => {
    const me = actsForOf(c);
    if (me === undefined) return false;
    if (f.createdBy === me) return true;
    return f.ownerRunId !== undefined && (await ownRun(c, f.ownerRunId)) !== undefined;
  };
  /** `read` on its project, or `run` there on a file of the caller's own. */
  const maySee = async (c: Context<AppEnv>, f: StoredFile) =>
    (await may(c, 'read', f)) ||
    (authorizer !== undefined &&
      f.projectId !== undefined &&
      (await ownFile(c, f)) &&
      (await authorizer.can(c, 'run', scopeOf(c, f))));

  /** The file, when the caller may see it; otherwise the 404 that answers. */
  const seen = async (
    c: Context<AppEnv>,
  ): Promise<{ readonly file: StoredFile } | { readonly answer: Response }> => {
    const fileId = c.req.param('fileId') as FileId;
    const file = await binding.get(tenantOf(c), fileId);
    if (file === null || !(await maySee(c, file))) return { answer: fileNotFound(c, fileId) };
    return { file };
  };
  /** As `seen`, and `write` on its project; otherwise the answer that refuses. */
  const changeable = async (
    c: Context<AppEnv>,
  ): Promise<{ readonly file: StoredFile } | { readonly answer: Response }> => {
    const got = await seen(c);
    if ('answer' in got) return got;
    if (!(await may(c, 'write', got.file))) {
      return {
        answer: denied(c, `Not allowed to change file "${got.file.fileId as unknown as string}"`),
      };
    }
    return got;
  };

  // ---------- GET / (list) ----------
  r.get('/', async (c) => {
    const tenantId = tenantOf(c);
    const filter = decodeFileFilter(new URL(c.req.url).searchParams, tenantId);
    const cursor = c.req.query('cursor');
    const page = await binding.list(
      tenantId,
      filter,
      cursor !== undefined && cursor.length > 0 ? (cursor as Cursor) : undefined,
      clampLimit(c.req.query('limit')),
    );
    if (page.kind === 'err') return fileErrorAnswer(c, page.error);
    // `read` on a file's project; with `?ownerRunId=` of a run of the
    // caller's own, `run` there too, so the run's files fill the page.
    const own =
      authorizer !== undefined && filter.ownerRunId !== undefined
        ? await ownRun(c, filter.ownerRunId)
        : undefined;
    const visible =
      authorizer === undefined
        ? page.value.data
        : await readableOrRun(
            authorizer,
            c,
            page.value.data,
            (f) => scopeOf(c, f),
            (f) =>
              own !== undefined && f.ownerRunId === own.runId && f.projectId !== undefined
                ? (f.projectId as unknown as string)
                : undefined,
          );
    return c.json(pageOf(visible.map(serializeFile), page.value.nextCursor));
  });

  // ---------- POST / (create: version 1 of a new file) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = tenantOf(c);
    const form = await readForm(c, 'POST /v1/files');
    if ('answer' in form) return form.answer;
    const validated = validateUploadForm(form.value);
    if (validated.kind === 'err') return badInput(c, validated.message);
    const project = await uploadProject(c, deps, validated.value);
    if (project.kind === 'err') {
      c.status(statusFor(project.code) as never);
      return c.json(toWireError({ code: project.code, message: project.message }, requestId));
    }
    const keyProject = c.get('tokenProjectId');
    if (keyProject !== undefined && project.projectId !== keyProject) {
      const named = project.projectId as unknown as string;
      return refused(c, authorizer, {
        action: 'write',
        resource: ref('project', named),
        message: `This API key is limited to project ${keyProject}; the file belongs to project ${named}`,
        failing: 'scope',
        code: 'key-project-mismatch',
        details: { keyProjectId: keyProject, projectId: named },
      });
    }
    const createdBy = madeBy(c);
    // `write`, or `run` for a file of the caller's own that names no run:
    // an input for a run they start. One that names a run stays `write`.
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'write', projectRef(c, project.projectId))) &&
      !(
        project.projectId !== undefined &&
        validated.value.ownerRunId === undefined &&
        createdBy !== undefined &&
        createdBy === actsForOf(c) &&
        (await authorizer.can(c, 'run', ref('project', project.projectId as unknown as string)))
      )
    ) {
      return denied(c, 'Not allowed to add files to this project');
    }
    const outcome = await binding.create(tenantId, {
      ...validated.value,
      ...(project.projectId !== undefined && { projectId: project.projectId }),
      ...(createdBy !== undefined && { createdBy }),
    });
    if (outcome.kind === 'err') return fileErrorAnswer(c, outcome.error);
    return writeAnswer(c, outcome.value);
  });

  // ---------- GET /:fileId ----------
  r.get('/:fileId', async (c) => {
    const got = await seen(c);
    if ('answer' in got) return got.answer;
    return c.json(serializeFile(got.file));
  });

  // ---------- DELETE /:fileId (the file and every version) ----------
  r.delete('/:fileId', async (c) => {
    const got = await changeable(c);
    if ('answer' in got) return got.answer;
    const outcome = await binding.delete(tenantOf(c), got.file.fileId);
    if (outcome.kind === 'err') return fileErrorAnswer(c, outcome.error);
    return c.json({ fileId: got.file.fileId as unknown as string, deleted: outcome.value.deleted });
  });

  // ---------- GET /:fileId/versions ----------
  r.get('/:fileId/versions', async (c) => {
    const got = await seen(c);
    if ('answer' in got) return got.answer;
    const cursor = c.req.query('cursor');
    const page = await binding.listVersions(
      tenantOf(c),
      got.file.fileId,
      cursor !== undefined && cursor.length > 0 ? (cursor as Cursor) : undefined,
      clampLimit(c.req.query('limit')),
    );
    if (page.kind === 'err') return fileErrorAnswer(c, page.error);
    return c.json(pageOf(page.value.data.map(serializeVersion), page.value.nextCursor));
  });

  // ---------- POST /:fileId/versions (add a version) ----------
  r.post('/:fileId/versions', async (c) => {
    const got = await changeable(c);
    if ('answer' in got) return got.answer;
    const form = await readForm(c, 'POST /v1/files/{fileId}/versions');
    if ('answer' in form) return form.answer;
    const validated = validateUploadForm(form.value);
    if (validated.kind === 'err') return badInput(c, validated.message);
    const expected = expectedVersionField(form.value.get('expectedVersion'));
    if (expected.kind === 'err') return badInput(c, expected.message);
    // A version stays in its file's project, and keeps Latest's name unless
    // the form names one: the file part's own filename doesn't rename it.
    const { name: _partName, ownerRunId, projectId, ...bytes } = validated.value;
    if (ownerRunId !== undefined || projectId !== undefined) {
      return badInput(c, "A version stays in its file's project: no `ownerRunId` or `projectId`");
    }
    const named = form.value.get('name');
    const createdBy = madeBy(c);
    const outcome = await binding.addVersion(tenantOf(c), got.file.fileId, {
      ...bytes,
      ...(typeof named === 'string' && named.length > 0 && { name: named }),
      ...(expected.value !== undefined && { expectedVersion: expected.value }),
      ...(createdBy !== undefined && { createdBy }),
    });
    if (outcome.kind === 'err') return fileErrorAnswer(c, outcome.error);
    return writeAnswer(c, outcome.value);
  });

  // ---------- GET /:fileId/versions/:version ----------
  r.get('/:fileId/versions/:version', async (c) => {
    const got = await seen(c);
    if ('answer' in got) return got.answer;
    const version = selectorOf(c.req.param('version'));
    if (version === undefined) return badVersion(c);
    const outcome = await binding.getVersion(tenantOf(c), got.file.fileId, version);
    if (outcome.kind === 'err') return fileErrorAnswer(c, outcome.error);
    return c.json(serializeVersion(outcome.value));
  });

  // ---------- GET /:fileId/versions/:version/content, and HEAD ----------
  r.get('/:fileId/versions/:version/content', async (c) => {
    const requestId = c.get('requestId');
    const got = await seen(c);
    if ('answer' in got) return got.answer;
    const version = selectorOf(c.req.param('version'));
    if (version === undefined) return badVersion(c);
    // Hono answers a HEAD with this GET route and drops the body. So a HEAD
    // answers from the record and never opens the bytes, as the artifacts
    // download does.
    if (c.req.method === 'HEAD') {
      const meta = await binding.getVersion(tenantOf(c), got.file.fileId, version);
      if (meta.kind === 'err') return fileErrorAnswer(c, meta.error);
      if (meta.value.deletedAt !== undefined || meta.value.purgedAt !== undefined) {
        return versionNotFound(c, got.file.fileId, version);
      }
      return new Response(null, { status: 200, headers: contentHeaders(meta.value, requestId) });
    }
    const outcome = await binding.readVersion(tenantOf(c), got.file.fileId, version);
    if (outcome.kind === 'err') return fileErrorAnswer(c, outcome.error);
    return new Response(outcome.value.stream, {
      status: 200,
      headers: contentHeaders(outcome.value.version, requestId),
    });
  });

  // ---------- POST /:fileId/versions/:version/restore ----------
  r.post('/:fileId/versions/:version/restore', async (c) => {
    const got = await changeable(c);
    if ('answer' in got) return got.answer;
    const version = numberOf(c.req.param('version'));
    if (version === undefined) return badVersion(c);
    const body = await optionalJson(c);
    if ('answer' in body) return body.answer;
    const expected = expectedVersionField(body.value.expectedVersion);
    if (expected.kind === 'err') return badInput(c, expected.message);
    const createdBy = madeBy(c);
    const outcome = await binding.restoreVersion(tenantOf(c), got.file.fileId, version, {
      ...(expected.value !== undefined && { expectedVersion: expected.value }),
      ...(createdBy !== undefined && { createdBy }),
    });
    if (outcome.kind === 'err') return fileErrorAnswer(c, outcome.error);
    return writeAnswer(c, outcome.value);
  });

  // ---------- DELETE /:fileId/versions/:version ----------
  r.delete('/:fileId/versions/:version', async (c) => {
    const got = await changeable(c);
    if ('answer' in got) return got.answer;
    const version = numberOf(c.req.param('version'));
    if (version === undefined) return badVersion(c);
    const outcome = await binding.deleteVersion(tenantOf(c), got.file.fileId, version);
    if (outcome.kind === 'err') return fileErrorAnswer(c, outcome.error);
    return c.json({
      fileId: got.file.fileId as unknown as string,
      version,
      deleted: outcome.value.deleted,
    });
  });

  // ---------- POST /:fileId/versions/:version/pin and /unpin ----------
  for (const change of ['pin', 'unpin'] as const) {
    r.post(`/:fileId/versions/:version/${change}`, async (c) => {
      const got = await changeable(c);
      if ('answer' in got) return got.answer;
      const version = numberOf(c.req.param('version'));
      if (version === undefined) return badVersion(c);
      const body = await optionalJson(c);
      if ('answer' in body) return body.answer;
      const reason = body.value.reason;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
        return badInput(c, '`reason` must be text of at most 500 characters');
      }
      const by = madeBy(c);
      if (by === undefined) return denied(c, 'A pin needs a person or a service account');
      const input = { by, ...(reason !== undefined && reason.length > 0 && { reason }) };
      const outcome =
        change === 'pin'
          ? await binding.pinVersion(tenantOf(c), got.file.fileId, version, input)
          : await binding.unpinVersion(tenantOf(c), got.file.fileId, version, input);
      if (outcome.kind === 'err') return fileErrorAnswer(c, outcome.error);
      return c.json(serializeVersion(outcome.value));
    });
  }

  // ---------- GET /:fileId/pin-history ----------
  r.get('/:fileId/pin-history', async (c) => {
    const got = await seen(c);
    if ('answer' in got) return got.answer;
    const cursor = c.req.query('cursor');
    const page = await binding.pinHistory(
      tenantOf(c),
      got.file.fileId,
      cursor !== undefined && cursor.length > 0 ? (cursor as Cursor) : undefined,
      clampLimit(c.req.query('limit')),
    );
    if (page.kind === 'err') return fileErrorAnswer(c, page.error);
    return c.json(
      pageOf(
        page.value.data.map((p) => ({
          changeId: p.changeId,
          fileId: p.fileId as unknown as string,
          version: p.version,
          change: p.change,
          by: p.by,
          at: p.at as unknown as string,
          ...(p.reason !== undefined && { reason: p.reason }),
        })),
        page.value.nextCursor,
      ),
    );
  });

  return r;
}

// -------------------- answers --------------------

/** Who made a change: the caller, as `user:<id>` or `service_account:<id>`. */
function madeBy(c: Context<AppEnv>): string | undefined {
  return callerRef(c);
}

function projectRef(c: Context<AppEnv>, projectId: ProjectId | undefined): ResourceRef {
  return projectId !== undefined
    ? ref('project', projectId as unknown as string)
    : ref('tenant', c.get('tenantId') as unknown as string);
}

function writeAnswer(c: Context<AppEnv>, write: FileVersionWrite) {
  c.status(write.created ? 201 : 200);
  return c.json({ version: serializeVersion(write.version), created: write.created });
}

function fileErrorAnswer(c: Context<AppEnv>, error: FileError) {
  const busy = databaseBusyAnswer(error, c);
  if (busy !== undefined) return busy;
  c.status(statusFor(error.code) as never);
  return c.json(toWireError(error as never, c.get('requestId')));
}

function fileNotFound(c: Context<AppEnv>, fileId: string) {
  return fileErrorAnswer(c, { code: 'file-not-found', message: `No file "${fileId}"`, fileId });
}

function versionNotFound(c: Context<AppEnv>, fileId: string, version: FileVersionSelector) {
  return fileErrorAnswer(c, {
    code: 'file-version-not-found',
    message: `File "${fileId}" has no version ${version}`,
    fileId,
    version,
  });
}

function denied(c: Context<AppEnv>, message: string) {
  c.status(statusFor('permission-denied') as never);
  return c.json(toWireError({ code: 'permission-denied', message }, c.get('requestId')));
}

function badInput(c: Context<AppEnv>, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, c.get('requestId')));
}

function badVersion(c: Context<AppEnv>) {
  return badInput(c, 'A version is a number from 1, or `latest` where a read names one');
}

function pageOf<T>(data: readonly T[], nextCursor: Cursor | undefined) {
  return {
    data,
    hasMore: nextCursor !== undefined,
    ...(nextCursor !== undefined && { nextCursor: nextCursor as unknown as string }),
  };
}

function contentHeaders(v: FileVersion, requestId: string): Record<string, string> {
  return {
    ...savedFileHeaders(v),
    'Content-Length': String(v.size),
    'X-Kindgi-Blob-Hash': v.hash,
    'X-Kindgi-Blob-Name': encodeURIComponent(v.name),
    'X-Kindgi-File-Version': String(v.version),
    'X-Request-Id': requestId,
  };
}

// -------------------- serialization --------------------

function serializeFile(f: StoredFile): Record<string, unknown> {
  return {
    fileId: f.fileId as unknown as string,
    tenantId: f.tenantId as unknown as string,
    ...(f.projectId !== undefined && { projectId: f.projectId as unknown as string }),
    name: f.name,
    ...(f.createdBy !== undefined && { createdBy: f.createdBy }),
    ...(f.ownerRunId !== undefined && { ownerRunId: f.ownerRunId as unknown as string }),
    latestVersion: f.latestVersion,
    highestVersion: f.highestVersion,
    pinnedVersions: f.pinnedVersions,
    latest: serializeVersion(f.latest),
    createdAt: f.createdAt as unknown as string,
    updatedAt: f.updatedAt as unknown as string,
  };
}

function serializeVersion(v: FileVersion): Record<string, unknown> {
  return {
    fileId: v.fileId as unknown as string,
    version: v.version,
    blobId: v.blobId as unknown as string,
    name: v.name,
    contentType: v.contentType,
    size: v.size,
    hash: v.hash,
    tags: v.tags,
    ...(v.parentVersion !== undefined && { parentVersion: v.parentVersion }),
    ...(v.restoredFrom !== undefined && { restoredFrom: v.restoredFrom }),
    madeVia: v.madeVia,
    ...(v.createdBy !== undefined && { createdBy: v.createdBy }),
    ...(v.runId !== undefined && { runId: v.runId as unknown as string }),
    ...(v.callKey !== undefined && { callKey: v.callKey }),
    ...(v.toolId !== undefined && { toolId: v.toolId }),
    createdAt: v.createdAt as unknown as string,
    ...(v.supersededAt !== undefined && { supersededAt: v.supersededAt as unknown as string }),
    ...(v.pin !== undefined && {
      pin: {
        by: v.pin.by,
        at: v.pin.at as unknown as string,
        ...(v.pin.reason !== undefined && { reason: v.pin.reason }),
      },
    }),
    ...(v.deletedAt !== undefined && { deletedAt: v.deletedAt as unknown as string }),
    ...(v.purgedAt !== undefined && { purgedAt: v.purgedAt as unknown as string }),
  };
}

// -------------------- request parsing --------------------

async function readForm(
  c: Context<AppEnv>,
  route: string,
): Promise<{ readonly value: FormData } | { readonly answer: Response }> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return { answer: badInput(c, `${route} requires \`multipart/form-data\``) };
  }
  try {
    // From the body `readBodyOnce` kept, handed over whole to the parser.
    const value = await new Response(takeBody(c), {
      headers: { 'content-type': contentType },
    }).formData();
    return { value };
  } catch {
    return { answer: badInput(c, 'Malformed multipart body') };
  }
}

/** A JSON body that may be absent: an absent or empty one is `{}`. */
async function optionalJson(
  c: Context<AppEnv>,
): Promise<{ readonly value: Readonly<Record<string, unknown>> } | { readonly answer: Response }> {
  const text = await c.req.text();
  if (text.trim().length === 0) return { value: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { answer: badInput(c, 'The body must be a JSON object') };
    }
    return { value: parsed as Readonly<Record<string, unknown>> };
  } catch {
    return { answer: badInput(c, 'The body must be valid JSON') };
  }
}

/** `expectedVersion`, from a form field (text) or a JSON body (a number). */
function expectedVersionField(raw: unknown): ValidationResult<number | undefined> {
  if (raw === undefined || raw === null || raw === '') return { kind: 'ok', value: undefined };
  const n = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
  if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1) return { kind: 'ok', value: n };
  return { kind: 'err', message: '`expectedVersion` must be a version number from 1' };
}

/** A version number from 1, as a path or query parameter. */
function numberOf(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A version number from 1, or `latest`. */
function selectorOf(raw: string | undefined): FileVersionSelector | undefined {
  return raw === 'latest' ? 'latest' : numberOf(raw);
}

function decodeFileFilter(params: URLSearchParams, tenantId: TenantId): FileFilter {
  const filter: { ownerRunId?: RunId; contentType?: string; scope?: Scope } = {};
  const owner = params.get('ownerRunId');
  if (owner !== null && owner.length > 0) filter.ownerRunId = owner as RunId;
  const type = params.get('contentType');
  if (type !== null && type.length > 0) filter.contentType = type;
  const project = params.get('projectId');
  if (project !== null && project.length > 0) {
    filter.scope = { kind: 'project', tenantId, projectId: project as ProjectId };
  }
  return filter;
}
