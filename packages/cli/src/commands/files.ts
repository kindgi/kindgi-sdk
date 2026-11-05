// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import type {
  FilePinChange,
  FileVersion,
  FileVersionSelector,
  FileVersionWrite,
  ListPage,
  StoredFile,
} from '@kindgi/client';

import { guessContentType } from '../content-type-guess.js';
import type { CommandContext } from '../context.js';
import { UsageError, extractKindgiError } from '../errors.js';
import { type Rendered, renderJson, successNote } from '../output.js';
import { exists } from '../place-file.js';
import { existsError, ownName, saveWhole, unlessStopped } from '../save-download.js';
import { confirmRemoval } from './connections.js';
import {
  type TableSpec,
  integerFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
  tagsFlag,
} from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

/**
 * `kindgi files`: files kept in the runtime, with every version. A file's
 * id is its version 1's blob id, so an id `kindgi artifacts` printed is a
 * file id. Every command speaks only `files.*`.
 *
 * Reading needs `read` on the file's project; creating one needs `write`
 * (or `run`, for a file of your own that names no run), and every change
 * to it `write`.
 */

/** What every command says on a runtime without the file store. */
const NO_FILE_STORE: CommandResult = {
  kind: 'error',
  stderr: "This runtime doesn't keep files. Whoever runs it turns the file store on.\n",
  exitCode: 1,
};

/**
 * `fn` run through `runner` (`runSdk` or `runSdkRendered`), with one case
 * said plainly: a runtime without the file store answers every
 * `/v1/files` route `404 route-not-found`.
 */
async function inStore<T>(
  runner: (fn: () => Promise<T>) => Promise<CommandResult>,
  fn: () => Promise<T>,
): Promise<CommandResult> {
  let noStore = false;
  const result = await runner(async () => {
    try {
      return await fn();
    } catch (err) {
      const wire = extractKindgiError(err);
      noStore = wire?.code === 'not-found' && wire.serverCode === 'route-not-found';
      throw err;
    }
  });
  return noStore ? NO_FILE_STORE : result;
}

/**
 * The version at `index`: a whole number from 1, or `latest` where
 * `latest` is true. Undefined when it isn't given.
 */
function versionPositional(
  ctx: CommandContext,
  index: number,
  latest: boolean,
): FileVersionSelector | undefined {
  const raw = ctx.positionals[index];
  if (raw === undefined) return undefined;
  if (latest && raw === 'latest') return 'latest';
  const version = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    throw new UsageError(
      `<version> must be a whole number from 1${latest ? ', or latest' : ''}, got "${raw}"`,
    );
  }
  return version;
}

/** The version at `index`, a number, which the command needs. */
function requiredVersion(ctx: CommandContext, index: number): number {
  const version = versionPositional(ctx, index, false);
  if (version === undefined) throw new UsageError('Missing required argument: version');
  return version as number;
}

/** A version's state, from its marks and the file's Latest. */
function stateOf(v: FileVersion, latestVersion: number | undefined): string {
  if (v.purgedAt !== undefined) return 'purged';
  if (v.deletedAt !== undefined) return 'deleted';
  return v.version === latestVersion ? 'latest' : 'live';
}

/**
 * An answer that adds a version (`upload`, `restore`): as the API gave it,
 * and, when the bytes were Latest's already, a note that nothing was added.
 */
function writeRendered(ctx: CommandContext, write: FileVersionWrite): Rendered {
  const rendered = renderJson(write, ctx.globals.format);
  return write.created
    ? rendered
    : {
        ...rendered,
        stderr: successNote(
          ctx.globals.format,
          `Nothing new: these bytes are already version ${write.version.version}.\n`,
        ),
      };
}

/**
 * A `409 file-version-conflict` said as what happened, exit 1: Latest
 * moved past `--expected-version`, and nothing was written. Any other
 * error is thrown on.
 */
function latestMoved(err: unknown): Rendered & { readonly exitCode: number } {
  const wire = extractKindgiError(err) as {
    readonly code?: string;
    readonly reason?: string;
    readonly fields?: { readonly expectedVersion?: unknown; readonly latestVersion?: unknown };
  } | null;
  if (wire?.code !== 'conflict' || wire.reason !== 'file-version-conflict') throw err;
  const { expectedVersion, latestVersion } = wire.fields ?? {};
  return {
    stdout: '',
    stderr: `Latest is version ${String(latestVersion)}, not ${String(expectedVersion)}, so nothing was written.\n`,
    exitCode: 1,
  };
}

const PAGE_OPTIONS = {
  limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
  cursor: {
    type: 'string',
    description: "Resume after this cursor, from the previous page's `nextCursor`.",
  },
} as const;

/** `--limit` and `--cursor`, as the page filter takes them. */
function pageFilter(ctx: CommandContext): { limit?: number; cursor?: never } {
  const limit = integerFlag(ctx, 'limit');
  const cursor = stringFlag(ctx, 'cursor');
  return {
    ...(limit !== undefined && { limit }),
    ...(cursor !== undefined && { cursor: cursor as never }),
  };
}

const FILES_TABLE: TableSpec<ListPage<StoredFile>, StoredFile> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (f) => String(f.fileId) },
    { header: 'NAME', get: (f) => f.name },
    { header: 'TYPE', get: (f) => f.latest.contentType },
    { header: 'LATEST', get: (f) => `v${f.latestVersion}` },
    { header: 'SIZE', get: (f) => String(f.latest.size) },
    { header: 'PROJECT', get: (f) => f.projectId ?? '' },
    { header: 'RUN', get: (f) => (f.ownerRunId !== undefined ? String(f.ownerRunId) : '') },
    { header: 'UPDATED', get: (f) => String(f.updatedAt) },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List the files you can read, newest change first: by run, project or type.',
  usage:
    'kindgi files list [--run=<run-id>] [--project=<project-id>] [--content-type=<mime>] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    run: { type: 'string', description: 'Only the files whose version 1 this run made.' },
    project: { type: 'string', description: "Only one project's files." },
    'content-type': { type: 'string', description: "Only files whose Latest has this MIME type." },
    ...PAGE_OPTIONS,
  },
  run: (ctx) =>
    inStore(
      (fn) => runSdk(ctx, 'files list', fn, FILES_TABLE),
      async () => {
        const run = stringFlag(ctx, 'run');
        const project = stringFlag(ctx, 'project');
        const contentType = stringFlag(ctx, 'content-type');
        return await ctx.client().files.list({
          ...(run !== undefined && { ownerRunId: run }),
          ...(project !== undefined && { projectId: project }),
          ...(contentType !== undefined && { contentType }),
          ...pageFilter(ctx),
        });
      },
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description:
    'A file: its name, project and run, Latest, and its pinned versions. With a version, that version. Never its bytes.',
  usage: 'kindgi files get <file-id> [<version>]',
  run: (ctx) =>
    inStore(
      (fn) => runSdk(ctx, 'files get', fn),
      async (): Promise<StoredFile | FileVersion> => {
        const fileId = requiredPositional(ctx, 0, 'file-id');
        const version = versionPositional(ctx, 1, true);
        const files = ctx.client().files;
        return version === undefined
          ? await files.get(fileId)
          : await files.versions.get(fileId, version);
      },
    ),
};

/** The versions table: each one's state needs the file's Latest, which `latest()` gives once read. */
function versionsTable(
  latest: () => number | undefined,
): TableSpec<ListPage<FileVersion>, FileVersion> {
  return {
    rows: (page) => page.data,
    columns: [
      { header: 'VERSION', get: (v) => String(v.version) },
      { header: 'STATE', get: (v) => stateOf(v, latest()) },
      { header: 'CREATED', get: (v) => String(v.createdAt) },
      { header: 'BY', get: (v) => v.createdBy ?? '' },
      { header: 'HOW', get: (v) => v.madeVia },
      { header: 'SIZE', get: (v) => String(v.size) },
      { header: 'PINNED', get: (v) => (v.pin !== undefined ? 'yes' : '') },
    ],
  };
}

const versions: LeafCommand = {
  kind: 'leaf',
  name: 'versions',
  description:
    "Every version of a file, newest first, deleted and purged ones too, each with its state.",
  usage: 'kindgi files versions <file-id> [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: PAGE_OPTIONS,
  run: (ctx) => {
    let latestVersion: number | undefined;
    return inStore(
      (fn) => runSdk(ctx, 'files versions', fn, versionsTable(() => latestVersion)),
      async () => {
        const fileId = requiredPositional(ctx, 0, 'file-id');
        const files = ctx.client().files;
        const page = await files.versions.list(fileId, pageFilter(ctx));
        // The table says which one is Latest, which the page doesn't.
        if (ctx.globals.format === 'table') latestVersion = (await files.get(fileId)).latestVersion;
        return page;
      },
    );
  },
};

/** A download the stop ended: no file written, and the exit code says so. */
const STOPPED: CommandResult = {
  kind: 'error',
  stderr: 'kindgi files download stopped: no file was written.\n',
  exitCode: 130,
};

const download: LeafCommand = {
  kind: 'leaf',
  name: 'download',
  description:
    "Download a version to a file, Latest unless one is named: -o's path, else its own name in this directory (an existing file is kept unless --force). The file is written only once the whole download has arrived.",
  usage: 'kindgi files download <file-id> [<version>] [-o <file>] [--force]',
  optionSpec: {
    o: { type: 'string', description: 'Write it to this file.' },
    force: { type: 'boolean', description: 'Overwrite the file if it exists.' },
  },
  run: async (ctx) => {
    const stop = ctx.stopSignal;
    const result = await inStore(
      (fn) => runSdk(ctx, 'files download', fn),
      async () => {
        const fileId = requiredPositional(ctx, 0, 'file-id');
        const version = versionPositional(ctx, 1, true) ?? 'latest';
        const got = await unlessStopped(
          ctx.client().files.versions.download(fileId, version),
          stop,
        );
        const target = resolve(ctx.cwd, stringFlag(ctx, 'o') ?? ownName(got.name, fileId));
        const force = ctx.options.force === true;
        if (!force && (await exists(target))) {
          await got.body.cancel();
          throw existsError(target);
        }
        const saved = await saveWhole(got, target, force, stop, `version ${got.version}'s`);
        return { fileId, version: got.version, file: target, ...saved };
      },
    );
    // Ctrl+C (or SIGTERM) during the download: a stop, not a failure.
    return result.kind === 'error' && stop?.aborted === true ? STOPPED : result;
  },
};

const upload: LeafCommand = {
  kind: 'leaf',
  name: 'upload',
  description:
    "Upload a file: version 1 of a new file, in its run's project, else --project's, else the workspace's default. With --to, a new version of that file. The runtime caps an upload (100 MiB unless set otherwise).",
  usage:
    'kindgi files upload <path> [--to=<file-id> [--expected-version=<n>]] [--name=<name>] [--content-type=<mime>] [--run=<run-id>] [--project=<project-id>] [--tag=<key>=<value>]…',
  optionSpec: {
    to: { type: 'string', description: 'Add a version to this file, which becomes its Latest.' },
    'expected-version': {
      type: 'string',
      description:
        "With --to: the version you built on. If Latest isn't it, nothing is written.",
    },
    name: {
      type: 'string',
      description: "Its name (default: the file's name; with --to, Latest's).",
    },
    'content-type': {
      type: 'string',
      description:
        "Its MIME type (default: from the file's extension, else `application/octet-stream`).",
    },
    run: { type: 'string', description: "The run that made it: it joins that run's project." },
    project: { type: 'string', description: 'With no --run: the project it belongs to.' },
    tag: { type: 'string', multiple: true, description: 'A label, `key=value` (repeatable).' },
  },
  run: (ctx) =>
    inStore(
      (fn) => runSdkRendered(ctx, 'files upload', fn),
      async () => {
        const path = requiredPositional(ctx, 0, 'path');
        const to = stringFlag(ctx, 'to');
        const expectedVersion = integerFlag(ctx, 'expected-version');
        const run = stringFlag(ctx, 'run');
        const project = stringFlag(ctx, 'project');
        if (to === undefined && expectedVersion !== undefined) {
          throw new UsageError('--expected-version goes with --to: a new file has no version yet');
        }
        if (to !== undefined && (run !== undefined || project !== undefined)) {
          throw new UsageError(
            "--to adds a version, which stays in its file's project: leave out --run and --project",
          );
        }
        const body = new Uint8Array(await readFile(resolve(ctx.cwd, path)));
        const name = stringFlag(ctx, 'name');
        const contentType = stringFlag(ctx, 'content-type') ?? guessContentType(path);
        const tags = tagsFlag(ctx);
        const files = ctx.client().files;
        if (to === undefined) {
          return writeRendered(
            ctx,
            await files.create({
              body,
              name: name ?? basename(path),
              contentType,
              ...(run !== undefined && { ownerRunId: run }),
              ...(project !== undefined && { projectId: project }),
              ...(tags !== undefined && { tags }),
            }),
          );
        }
        try {
          return writeRendered(
            ctx,
            await files.versions.add(to, {
              body,
              contentType,
              ...(name !== undefined && { name }),
              ...(expectedVersion !== undefined && { expectedVersion }),
              ...(tags !== undefined && { tags }),
            }),
          );
        } catch (err) {
          return latestMoved(err);
        }
      },
    ),
};

const restore: LeafCommand = {
  kind: 'leaf',
  name: 'restore',
  description:
    "Add a version with an earlier version's bytes, which becomes Latest. Nothing is removed.",
  usage: 'kindgi files restore <file-id> <version> [--expected-version=<n>]',
  optionSpec: {
    'expected-version': {
      type: 'string',
      description: "The Latest you expect. If Latest isn't it, nothing is written.",
    },
  },
  run: (ctx) =>
    inStore(
      (fn) => runSdkRendered(ctx, 'files restore', fn),
      async () => {
        const fileId = requiredPositional(ctx, 0, 'file-id');
        const version = requiredVersion(ctx, 1);
        const expectedVersion = integerFlag(ctx, 'expected-version');
        try {
          return writeRendered(
            ctx,
            await ctx
              .client()
              .files.versions.restore(
                fileId,
                version,
                expectedVersion !== undefined ? { expectedVersion } : {},
              ),
          );
        } catch (err) {
          return latestMoved(err);
        }
      },
    ),
};

const REASON = {
  reason: { type: 'string', description: 'Why, kept with the change (at most 500 characters).' },
} as const;

/** `pin` or `unpin`: a keep mark on one version, with who, when and why. */
function pinCommand(name: 'pin' | 'unpin', description: string): LeafCommand {
  return {
    kind: 'leaf',
    name,
    description,
    usage: `kindgi files ${name} <file-id> <version> [--reason=<text>]`,
    optionSpec: REASON,
    run: (ctx) =>
      inStore(
        (fn) => runSdk(ctx, `files ${name}`, fn),
        async () => {
          const fileId = requiredPositional(ctx, 0, 'file-id');
          const version = requiredVersion(ctx, 1);
          const reason = stringFlag(ctx, 'reason');
          return await ctx
            .client()
            .files.versions[name](fileId, version, reason !== undefined ? { reason } : {});
        },
      ),
  };
}

const pin = pinCommand(
  'pin',
  "Pin a version: it can't be deleted, and retention keeps it. Latest doesn't move.",
);
const unpin = pinCommand('unpin', "Take a version's pin off. Latest doesn't move.");

const PIN_HISTORY_TABLE: TableSpec<ListPage<FilePinChange>, FilePinChange> = {
  rows: (page) => page.data,
  columns: [
    { header: 'VERSION', get: (c) => String(c.version) },
    { header: 'CHANGE', get: (c) => c.change },
    { header: 'BY', get: (c) => c.by },
    { header: 'AT', get: (c) => String(c.at) },
    { header: 'REASON', get: (c) => c.reason ?? '' },
  ],
};

const pinHistory: LeafCommand = {
  kind: 'leaf',
  name: 'pin-history',
  description: "Every pin and unpin of a file's versions, newest first.",
  usage: 'kindgi files pin-history <file-id> [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: PAGE_OPTIONS,
  run: (ctx) =>
    inStore(
      (fn) => runSdk(ctx, 'files pin-history', fn, PIN_HISTORY_TABLE),
      async () =>
        ctx.client().files.pinHistory(requiredPositional(ctx, 0, 'file-id'), pageFilter(ctx)),
    ),
};

/** How many of a file's versions aren't deleted, for the question `delete` asks. */
async function liveVersions(ctx: CommandContext, fileId: string): Promise<number> {
  let live = 0;
  let cursor: string | undefined;
  do {
    const page = await ctx
      .client()
      .files.versions.list(fileId, { limit: 100, ...(cursor !== undefined && { cursor: cursor as never }) });
    live += page.data.filter((v) => v.deletedAt === undefined && v.purgedAt === undefined).length;
    cursor = page.hasMore ? (page.nextCursor as string | undefined) : undefined;
  } while (cursor !== undefined);
  return live;
}

const del: LeafCommand = {
  kind: 'leaf',
  name: 'delete',
  description:
    'Delete a file and every version, or with a version, that version. It asks first. Deleted versions stay until the retention policy for `file_version` purges them.',
  usage: 'kindgi files delete <file-id> [<version>] [--yes]',
  optionSpec: {
    yes: { type: 'boolean', description: "Don't ask first (for scripts)." },
  },
  run: (ctx) =>
    inStore(
      (fn) => runSdkRendered(ctx, 'files delete', fn),
      async () => {
        const fileId = requiredPositional(ctx, 0, 'file-id');
        const version = versionPositional(ctx, 1, false) as number | undefined;
        const files = ctx.client().files;
        const ok = await confirmRemoval(ctx, 'files delete', async () => {
          const file = await files.get(fileId);
          if (version !== undefined) return `Delete version ${version} of ${file.name}?`;
          const live = await liveVersions(ctx, fileId);
          return `Delete ${file.name} and its ${live === 1 ? 'one version' : `${live} versions`}?`;
        });
        if (ok.kind === 'refused') return { stdout: '', stderr: ok.stderr, exitCode: 1 };
        return renderJson(
          version === undefined
            ? await files.delete(fileId)
            : await files.versions.delete(fileId, version),
          ctx.globals.format,
        );
      },
    ),
};

export const filesCommand: Command = {
  kind: 'group',
  name: 'files',
  description:
    'Files kept in the runtime, with every version: list, get, versions, download, upload, restore, pin, unpin, pin-history, delete.',
  subcommands: [list, get, versions, download, upload, restore, pin, unpin, pinHistory, del],
};
