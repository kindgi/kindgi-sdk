// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createWriteStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { BlobMeta, ListPage } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import {
  type TableSpec,
  integerFlag,
  listFlag,
  requiredPositional,
  runSdk,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi artifacts`: files runs and people keep in the runtime. Every
 * artifact belongs to a project (its run's, else `--project`, else the
 * tenant's default): reading needs `read` there, uploading and deleting
 * `write`.
 */

const TABLE: TableSpec<ListPage<BlobMeta>, BlobMeta> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (m) => String(m.blobId) },
    { header: 'NAME', get: (m) => m.name },
    { header: 'TYPE', get: (m) => m.contentType },
    { header: 'SIZE', get: (m) => String(m.size) },
    { header: 'PROJECT', get: (m) => m.projectId ?? '' },
    { header: 'RUN', get: (m) => (m.ownerRunId !== undefined ? String(m.ownerRunId) : '') },
    { header: 'CREATED', get: (m) => String(m.createdAt) },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List artifacts you can read, newest first: by run, project or type.',
  usage:
    'kindgi artifacts list [--run=<run-id>] [--project=<project-id>] [--content-type=<mime>] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    run: { type: 'string', description: 'Only the artifacts this run produced.' },
    project: { type: 'string', description: "Only one project's artifacts." },
    'content-type': { type: 'string', description: 'Only this MIME type.' },
    limit: {
      type: 'string',
      description: 'The most artifacts to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'artifacts list',
      async () => {
        const run = stringFlag(ctx, 'run');
        const project = stringFlag(ctx, 'project');
        const contentType = stringFlag(ctx, 'content-type');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().artifacts.list({
          ...(run !== undefined && { ownerRunId: run as never }),
          ...(project !== undefined && { projectId: project }),
          ...(contentType !== undefined && { contentType }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor: cursor as never }),
        });
      },
      TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: "An artifact's name, type, size and sha256, without its bytes.",
  usage: 'kindgi artifacts get <blob-id>',
  run: (ctx) =>
    runSdk(ctx, 'artifacts get', async () =>
      ctx.client().artifacts.head(requiredPositional(ctx, 0, 'blob-id') as never),
    ),
};

/** `--tag=key=value`, repeatable. */
function tagsFlag(ctx: CommandContext): Record<string, string> | undefined {
  const raw = listFlag(ctx, 'tag');
  if (raw.length === 0) return undefined;
  const tags: Record<string, string> = {};
  for (const t of raw) {
    const eq = t.indexOf('=');
    if (eq <= 0) throw new UsageError(`--tag must be key=value, got "${t}"`);
    tags[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return tags;
}

const upload: LeafCommand = {
  kind: 'leaf',
  name: 'upload',
  description:
    "Upload a file as an artifact: it belongs to its run's project, else --project's, else the tenant's default. The runtime caps an upload (100 MB unless set otherwise).",
  usage:
    'kindgi artifacts upload <file> [--name=<name>] [--content-type=<mime>] [--run=<run-id>] [--project=<project-id>] [--tag=<key>=<value>]…',
  optionSpec: {
    name: { type: 'string', description: "Its name (default: the file's name)." },
    'content-type': {
      type: 'string',
      description:
        'Its MIME type, such as `application/pdf` (default: `application/octet-stream`).',
    },
    run: { type: 'string', description: "The run that produced it: it joins that run's project." },
    project: { type: 'string', description: 'With no --run: the project it belongs to.' },
    tag: { type: 'string', multiple: true, description: 'A label, `key=value` (repeatable).' },
  },
  run: (ctx) =>
    runSdk(ctx, 'artifacts upload', async () => {
      const file = requiredPositional(ctx, 0, 'file');
      const body = await readFile(resolve(ctx.cwd, file));
      const name = stringFlag(ctx, 'name') ?? basename(file);
      const contentType = stringFlag(ctx, 'content-type');
      const run = stringFlag(ctx, 'run');
      const project = stringFlag(ctx, 'project');
      const tags = tagsFlag(ctx);
      return await ctx.client().artifacts.upload({
        body: new Uint8Array(body),
        name,
        ...(contentType !== undefined && { contentType }),
        ...(run !== undefined && { ownerRunId: run as never }),
        ...(project !== undefined && { projectId: project }),
        ...(tags !== undefined && { tags }),
      });
    }),
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const download: LeafCommand = {
  kind: 'leaf',
  name: 'download',
  description:
    "Download an artifact to a file: -o's path, else its own name in this directory (an existing file is kept unless --force).",
  usage: 'kindgi artifacts download <blob-id> [-o <file>] [--force]',
  optionSpec: {
    o: { type: 'string', description: 'Write it to this file.' },
    force: { type: 'boolean', description: 'Overwrite the file if it exists.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'artifacts download', async () => {
      const blobId = requiredPositional(ctx, 0, 'blob-id');
      const got = await ctx.client().artifacts.download(blobId as never);
      const target = resolve(ctx.cwd, stringFlag(ctx, 'o') ?? basename(got.name || blobId));
      if (ctx.options.force !== true && (await exists(target))) {
        await got.body.cancel();
        throw new Error(`${target} exists: pass --force to overwrite it, or -o <file>`);
      }
      await pipeline(
        Readable.fromWeb(got.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(target),
      );
      return { blobId, file: target, size: got.size, hash: got.hash };
    }),
};

const del: LeafCommand = {
  kind: 'leaf',
  name: 'delete',
  description:
    'Delete an artifact. It stays recoverable until the retention policy for `artifact` purges it.',
  usage: 'kindgi artifacts delete <blob-id>',
  run: (ctx) =>
    runSdk(ctx, 'artifacts delete', async () =>
      ctx.client().artifacts.delete(requiredPositional(ctx, 0, 'blob-id') as never),
    ),
};

export const artifactsCommand: Command = {
  kind: 'group',
  name: 'artifacts',
  description: 'Files kept in the runtime, each in a project: list, get, upload, download, delete.',
  subcommands: [list, get, upload, download, del],
};
