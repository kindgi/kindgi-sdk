// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { CapabilityDeclaration, ListPage } from '@kindgi/client';

import { type TableSpec, integerFlag, requiredPositional, runSdk, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi capabilities`: the features an agent can require
 * (`needs: [{ feature }]`), what each means, and which of the tenant's
 * providers have a model with it.
 */

/** `acme-openai: gpt-acme, gpt-mini; local: qwen`. */
function providersCell(d: CapabilityDeclaration): string {
  if (d.providers === undefined) return '';
  if (d.providers.length === 0) return 'none of yours';
  return d.providers.map((p) => `${p.providerId}: ${p.models.join(', ')}`).join('; ');
}

const TABLE: TableSpec<ListPage<CapabilityDeclaration>, CapabilityDeclaration> = {
  rows: (page) => page.data,
  columns: [
    { header: 'FEATURE', get: (d) => d.feature },
    { header: 'MEANS', get: (d) => d.description },
    { header: 'YOUR MODELS', get: providersCell },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "The features an agent can require (`needs: [{ feature }]`), what each means, and which of your providers' models have it.",
  usage: 'kindgi capabilities list [--feature=<prefix>] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    feature: {
      type: 'string',
      description: 'Only the capabilities whose feature starts with this prefix.',
    },
    limit: { type: 'string', description: 'The most capabilities to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'capabilities list',
      async () => {
        const feature = stringFlag(ctx, 'feature');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().capabilities.list({
          ...(feature !== undefined && { feature }),
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
  description:
    'One capability, by id (`feature:<feature>`), with the models of yours that have it.',
  usage: 'kindgi capabilities get <capability-id>',
  run: (ctx) =>
    runSdk(ctx, 'capabilities get', async () =>
      ctx.client().capabilities.get(requiredPositional(ctx, 0, 'capability-id')),
    ),
};

export const capabilitiesCommand: Command = {
  kind: 'group',
  name: 'capabilities',
  description:
    'The features an agent can require, what each means, and your models that have them.',
  subcommands: [list, get],
};
