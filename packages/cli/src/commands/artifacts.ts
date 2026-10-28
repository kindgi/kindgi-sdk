// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomBytes } from 'node:crypto';
import { access, link, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { BlobMeta, DownloadedArtifact, ListPage } from '@kindgi/client';

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
    "Upload a file as an artifact: it belongs to its run's project, else --project's, else the tenant's default. The runtime caps an upload (100 MiB unless set otherwise).",
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

const existsError = (target: string) =>
  new Error(`${target} exists: pass --force to overwrite it, or -o <file>`);

/** What `link` answers on a file system with no hard links. */
const NO_HARD_LINKS: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Without --force, `partial` takes `target`'s name only while nothing has
 * it, a file that turned up there during the download included: `link`
 * refuses a name that's taken in one step. Where the file system has no
 * hard links, `target` is looked for again right before the rename.
 */
async function placeNew(partial: string, target: string): Promise<void> {
  try {
    await link(partial, target);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw existsError(target);
    if (code === undefined || !NO_HARD_LINKS.has(code)) throw err;
  }
  if (await exists(target)) throw existsError(target);
  await rename(partial, target);
}

/**
 * The body written to a new file beside `target` (as `kindgi exports
 * create` writes its files), which takes `target`'s name only once the
 * whole body has arrived: the stream ended, with the sha256 the server
 * sent. With `force`, it is renamed over `target`; without, it takes the
 * name only while nothing has it (`placeNew`). Otherwise that file is
 * removed, and `target` is as it was. Returns the size and sha256 of the
 * bytes written.
 */
async function saveWhole(
  got: DownloadedArtifact,
  target: string,
  force: boolean,
): Promise<{ size: number; hash: string }> {
  const partial = `${target}.${randomBytes(4).toString('hex')}.partial`;
  const file = await open(partial, 'wx').catch(async (err: unknown) => {
    await got.body.cancel();
    throw err;
  });
  const sha256 = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(got.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          sha256.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      file.createWriteStream(),
    );
  } catch (err) {
    await rm(partial, { force: true });
    throw new Error(
      `the download stopped part way (${(err as Error).message}): ${target} wasn't written`,
      { cause: err },
    );
  }
  // The route sends the sha256 as lowercase hex, as digest('hex') gives it.
  const hash = sha256.digest('hex');
  // With no hash header (a proxy may drop it), the stream's end is all there is to go on.
  if (got.hash !== '' && hash !== got.hash) {
    await rm(partial, { force: true });
    throw new Error(
      `the bytes that arrived have the sha256 ${hash}, not the artifact's ${got.hash}: ${target} wasn't written`,
    );
  }
  try {
    await (force ? rename(partial, target) : placeNew(partial, target));
  } finally {
    // Gone after a rename; after a link, its second name; after a failure, the file.
    await rm(partial, { force: true });
  }
  return { size, hash };
}

/** The file a download writes unless `-o` names one: the artifact's own name, or its id when that name is no file's. */
function ownName(name: string, blobId: string): string {
  const own = basename(name);
  return own === '' || own === '.' || own === '..' ? basename(blobId) : own;
}

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
  run: (ctx) =>
    runSdk(ctx, 'artifacts download', async () => {
      const blobId = requiredPositional(ctx, 0, 'blob-id');
      const got = await ctx.client().artifacts.download(blobId as never);
      const target = resolve(ctx.cwd, stringFlag(ctx, 'o') ?? ownName(got.name, blobId));
      const force = ctx.options.force === true;
      if (!force && (await exists(target))) {
        await got.body.cancel();
        throw existsError(target);
      }
      const saved = await saveWhole(got, target, force);
      return { blobId, file: target, ...saved };
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
