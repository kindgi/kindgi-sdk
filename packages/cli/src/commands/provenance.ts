// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { requiredPositional, runSdk, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List provenance records.',
  usage: 'kindgi provenance list [--limit=<n>] [--cursor=<c>]',
  optionSpec: { limit: { type: 'string' }, cursor: { type: 'string' } },
  run: (ctx) => runSdk(ctx, 'provenance list', async () => throwUnwired('provenance.list')),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a provenance record by run id.',
  usage: 'kindgi provenance get <run-id>',
  run: (ctx) =>
    runSdk(ctx, 'provenance get', async () => {
      requiredPositional(ctx, 0, 'run-id');
      throwUnwired('provenance.get');
    }),
};

const exportCmd: LeafCommand = {
  kind: 'leaf',
  name: 'export',
  description: 'Export a signed provenance bundle.',
  usage: 'kindgi provenance export <run-id> [--input=<json-or-@file>]',
  optionSpec: { input: { type: 'string' } },
  run: (ctx) =>
    runSdk(ctx, 'provenance export', async () => {
      requiredPositional(ctx, 0, 'run-id');
      throwUnwired('provenance.export');
    }),
};

export const provenanceCommand: Command = {
  kind: 'group',
  name: 'provenance',
  description: 'Manage provenance records.',
  subcommands: [list, get, exportCmd],
};
