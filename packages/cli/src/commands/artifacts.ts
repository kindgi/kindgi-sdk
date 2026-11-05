// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import type { BlobMeta, ListPage } from '@kindgi/client';

import { exists } from '../place-file.js';
import { existsError, ownName, saveWhole, unlessStopped } from '../save-download.js';
import {
  type TableSpec,
  integerFlag,
  requiredPositional,
  runSdk,
  stringFlag,
  tagsFlag,
} from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

/**
 * `kindgi artifacts`: files runs and people keep in the runtime. Every
 * artifact belongs to a project (its run's, else `--project`, else the
 * tenant's default): reading needs `read` there, uploading and deleting
 * `write`.
 *
 * Deprecated: `kindgi files` takes its place, with the same ids. Until
 * 0.8.0 removes it, each command does what it did and says on stderr
 * which one to use instead (`DEPRECATED_COMMANDS`).
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

const upload: LeafCommand = {
  kind: 'leaf',
  name: 'upload',
  description:
    "Upload a file as an artifact: it belongs to its run's project, else --project's, else the workspace's default. The runtime caps an upload (100 MiB unless set otherwise).",
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

const download: LeafCommand = {
  kind: 'leaf',
  name: 'download',
  description:
    "Download an artifact to a file: -o's path, else its own name in this directory (an existing file is kept unless --force). The file is written only once the whole download has arrived.",
  usage: 'kindgi artifacts download <blob-id> [-o <file>] [--force]',
  optionSpec: {
    o: { type: 'string', description: 'Write it to this file.' },
    force: { type: 'boolean', description: 'Overwrite the file if it exists.' },
  },
  run: async (ctx) => {
    const stop = ctx.stopSignal;
    const result = await runSdk(ctx, 'artifacts download', async () => {
      const blobId = requiredPositional(ctx, 0, 'blob-id');
      const got = await unlessStopped(ctx.client().artifacts.download(blobId as never), stop);
      const target = resolve(ctx.cwd, stringFlag(ctx, 'o') ?? ownName(got.name, blobId));
      const force = ctx.options.force === true;
      if (!force && (await exists(target))) {
        await got.body.cancel();
        throw existsError(target);
      }
      const saved = await saveWhole(got, target, force, stop, "the artifact's");
      return { blobId, file: target, ...saved };
    });
    // Ctrl+C (or SIGTERM) during the download: a stop, not a failure, said
    // as `kindgi dev` says one while its runtime starts.
    return result.kind === 'error' && stop?.aborted === true ? STOPPED : result;
  },
};

/** A download the stop ended: no file written, and the exit code says so. */
const STOPPED: CommandResult = {
  kind: 'error',
  stderr: 'kindgi artifacts download stopped: no file was written.\n',
  exitCode: 130,
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
  description: 'Deprecated: use kindgi files. Removed in 0.8.0.',
  subcommands: [list, get, upload, download, del],
};
