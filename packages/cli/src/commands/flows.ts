// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { requiredPositional, runSdk, throwUnwired } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List registered flows.',
  usage: 'kindgi flows list [--limit=<n>] [--cursor=<c>]',
  optionSpec: { limit: { type: 'string' }, cursor: { type: 'string' } },
  run: (ctx) => runSdk(ctx, 'flows list', async () => throwUnwired('flows.list')),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'Fetch a registered flow by id.',
  usage: 'kindgi flows get <flow-id>',
  run: (ctx) =>
    runSdk(ctx, 'flows get', async () => {
      requiredPositional(ctx, 0, 'flow-id');
      throwUnwired('flows.get');
    }),
};

const publish: LeafCommand = {
  kind: 'leaf',
  name: 'publish',
  description: 'Publish a flow definition.',
  usage: 'kindgi flows publish --spec=<json-or-@file>',
  optionSpec: { spec: { type: 'string' } },
  run: (ctx) => runSdk(ctx, 'flows publish', async () => throwUnwired('flows.publish')),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description: 'Unregister a specific flow version.',
  usage: 'kindgi flows unregister <flow-id> --version=<semver>',
  optionSpec: { version: { type: 'string' } },
  run: (ctx) =>
    runSdk(ctx, 'flows unregister', async () => {
      requiredPositional(ctx, 0, 'flow-id');
      throwUnwired('flows.unregister');
    }),
};

export const flowsCommand: Command = {
  kind: 'group',
  name: 'flows',
  description: 'Manage flow registrations.',
  subcommands: [list, get, publish, unregister],
};
