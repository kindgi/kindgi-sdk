// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { requiredPositional, runSdk, stringFlag, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List artifacts.',
  usage: 'kindgi artifacts list [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    limit: {
      type: 'string',
      description: 'The most artifacts to return (default 25, at most 100).',
    },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) => runSdk(ctx, 'artifacts list', async () => throwUnwired('artifacts.list')),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch artifact metadata by id.',
  usage: 'kindgi artifacts get <blob-id>',
  run: (ctx) =>
    runSdk(ctx, 'artifacts get', async () => {
      requiredPositional(ctx, 0, 'blob-id');
      throwUnwired('artifacts.get');
    }),
};

const head: LeafCommand = {
  kind: 'leaf',
  name: 'head',
  description: 'HEAD an artifact (metadata only).',
  usage: 'kindgi artifacts head <blob-id>',
  run: (ctx) =>
    runSdk(ctx, 'artifacts head', async () => {
      requiredPositional(ctx, 0, 'blob-id');
      throwUnwired('artifacts.head');
    }),
};

const upload: LeafCommand = {
  kind: 'leaf',
  name: 'upload',
  description: 'Upload a file as an artifact.',
  usage: 'kindgi artifacts upload <file> [--content-type=<mime>]',
  optionSpec: {
    'content-type': {
      type: 'string',
      description: 'Store the artifact with this MIME type, such as `application/pdf`.',
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'artifacts upload', async () => {
      requiredPositional(ctx, 0, 'file');
      throwUnwired('artifacts.put');
    }),
};

const download: LeafCommand = {
  kind: 'leaf',
  name: 'download',
  description: 'Download an artifact.',
  usage: 'kindgi artifacts download <blob-id> [-o <file>]',
  optionSpec: {
    o: { type: 'string', description: 'Write the download to this file instead of stdout.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'artifacts download', async () => {
      requiredPositional(ctx, 0, 'blob-id');
      stringFlag(ctx, 'o');
      throwUnwired('artifacts.get');
    }),
};

const del: LeafCommand = {
  kind: 'leaf',
  name: 'delete',
  description: 'Delete an artifact.',
  usage: 'kindgi artifacts delete <blob-id>',
  run: (ctx) =>
    runSdk(ctx, 'artifacts delete', async () => {
      requiredPositional(ctx, 0, 'blob-id');
      throwUnwired('artifacts.delete');
    }),
};

export const artifactsCommand: Command = {
  kind: 'group',
  name: 'artifacts',
  description: 'Manage artifact blobs.',
  subcommands: [list, get, head, upload, download, del],
};
