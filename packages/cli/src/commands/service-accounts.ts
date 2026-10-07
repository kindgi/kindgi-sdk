// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ListPage,
  ServiceAccount,
  ServiceAccountGrant,
  ServiceAccountGrantTarget,
} from '@kindgi/client';

import type { CommandContext } from '../context.js';
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
 * `kindgi service-accounts`: named, non-human principals for an app, a
 * pipeline or a schedule, with grants of their own. They act through API
 * keys: `kindgi tokens create --for=sa:<id>`. Tenant admins only.
 */

const PROJECT_ROLES = ['viewer', 'editor', 'owner', 'admin', 'member'] as const;
type ProjectRole = (typeof PROJECT_ROLES)[number];

/** `--project=<project-id>:<role>`, repeatable: project grants. */
function projectGrants(ctx: CommandContext): ServiceAccountGrant[] {
  return listFlag(ctx, 'project').map((raw) => {
    const colon = raw.lastIndexOf(':');
    const projectId = raw.slice(0, colon);
    const role = raw.slice(colon + 1);
    if (colon <= 0 || !(PROJECT_ROLES as readonly string[]).includes(role)) {
      throw new Error(
        `--project must be <project-id>:<role>, the role one of ${PROJECT_ROLES.join(', ')}; got "${raw}"`,
      );
    }
    return { kind: 'project', projectId, role: role as ProjectRole };
  });
}

function grantsCell(a: ServiceAccount): string {
  return a.grants
    .map((g) => (g.kind === 'tenant-admin' ? 'tenant admin' : `${g.role} on ${g.projectId}`))
    .join('; ');
}

const TABLE: TableSpec<ListPage<ServiceAccount>, ServiceAccount> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (a) => a.serviceAccountId },
    { header: 'NAME', get: (a) => a.name },
    { header: 'GRANTS', get: grantsCell },
    { header: 'CREATED', get: (a) => String(a.createdAt) },
    {
      header: 'UNREGISTERED',
      get: (a) => (a.unregisteredAt !== undefined ? String(a.unregisteredAt) : ''),
    },
  ],
};

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    'Create a service account with its first grants, written before it answers: a key minted for it works at once.',
  usage:
    'kindgi service-accounts create <name> [--description=<text>] [--tenant-admin] [--project=<project-id>:<role>]…',
  optionSpec: {
    description: { type: 'string', description: 'What it is for.' },
    'tenant-admin': { type: 'boolean', description: 'Make it a tenant admin.' },
    project: {
      type: 'string',
      multiple: true,
      description: `A role on a project, \`<project-id>:<role>\` (repeatable); roles: ${PROJECT_ROLES.join(', ')}.`,
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'service-accounts create', async () => {
      const name = requiredPositional(ctx, 0, 'name');
      const description = stringFlag(ctx, 'description');
      const grants: ServiceAccountGrant[] = [
        ...(ctx.options['tenant-admin'] === true ? [{ kind: 'tenant-admin' } as const] : []),
        ...projectGrants(ctx),
      ];
      return await ctx.client().serviceAccounts.create({
        name,
        ...(description !== undefined && { description }),
        ...(grants.length > 0 && { grants }),
      });
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: 'List service accounts, oldest first; `--all` includes unregistered ones.',
  usage: 'kindgi service-accounts list [--all] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    all: { type: 'boolean', description: 'Unregistered accounts too.' },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'service-accounts list',
      async () => {
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().serviceAccounts.list({
          ...(ctx.options.all === true && { includeUnregistered: true }),
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
  description: 'One service account, with its grants.',
  usage: 'kindgi service-accounts get <service-account-id>',
  run: (ctx) =>
    runSdk(ctx, 'service-accounts get', async () =>
      ctx.client().serviceAccounts.get(requiredPositional(ctx, 0, 'service-account-id')),
    ),
};

/** `--tenant-admin`, or `--project=<id>`: exactly one. */
function targetFlags(ctx: CommandContext): ServiceAccountGrantTarget {
  const tenantAdmin = ctx.options['tenant-admin'] === true;
  const projectId = stringFlag(ctx, 'project');
  if (tenantAdmin === (projectId !== undefined)) {
    throw new Error('Give one of --tenant-admin or --project=<project-id>');
  }
  return tenantAdmin
    ? { kind: 'tenant-admin' }
    : { kind: 'project', projectId: projectId as string };
}

/** A grant: `--tenant-admin`, or `--project=<id>` with `--role`. */
function grantFlags(ctx: CommandContext): ServiceAccountGrant {
  const target = targetFlags(ctx);
  if (target.kind === 'tenant-admin') return target;
  const role = stringFlag(ctx, 'role');
  if (role === undefined || !(PROJECT_ROLES as readonly string[]).includes(role)) {
    throw new Error(`--role must be one of ${PROJECT_ROLES.join(', ')}`);
  }
  return { ...target, role: role as ProjectRole };
}

const grant: LeafCommand = {
  kind: 'leaf',
  name: 'grant',
  description:
    'Grant a service account tenant admin, or a role on a project (replacing its role there). Written before it answers.',
  usage:
    'kindgi service-accounts grant <service-account-id> (--tenant-admin | --project=<project-id> --role=<role>)',
  optionSpec: {
    'tenant-admin': { type: 'boolean', description: 'Tenant admin.' },
    project: { type: 'string', description: 'A project, by id.' },
    role: { type: 'string', description: `Its role there: ${PROJECT_ROLES.join(', ')}.` },
  },
  run: (ctx) =>
    runSdk(ctx, 'service-accounts grant', async () => {
      const id = requiredPositional(ctx, 0, 'service-account-id');
      return await ctx.client().serviceAccounts.grant(id, grantFlags(ctx));
    }),
};

const ungrant: LeafCommand = {
  kind: 'leaf',
  name: 'ungrant',
  description: 'Remove tenant admin, or the role on a project, from a service account.',
  usage:
    'kindgi service-accounts ungrant <service-account-id> (--tenant-admin | --project=<project-id>)',
  optionSpec: {
    'tenant-admin': { type: 'boolean', description: 'Tenant admin.' },
    project: { type: 'string', description: 'A project, by id.' },
  },
  run: (ctx) =>
    runSdk(ctx, 'service-accounts ungrant', async () => {
      const id = requiredPositional(ctx, 0, 'service-account-id');
      return await ctx.client().serviceAccounts.ungrant(id, targetFlags(ctx));
    }),
};

const unregister: LeafCommand = {
  kind: 'leaf',
  name: 'unregister',
  description:
    'Unregister a service account: its grants go and its keys are revoked. It stays readable.',
  usage: 'kindgi service-accounts unregister <service-account-id>',
  run: (ctx) =>
    runSdk(ctx, 'service-accounts unregister', async () =>
      ctx.client().serviceAccounts.unregister(requiredPositional(ctx, 0, 'service-account-id')),
    ),
};

export const serviceAccountsCommand: Command = {
  kind: 'group',
  name: 'service-accounts',
  description:
    'Service accounts: non-human principals with their own grants, acting through API keys (create / list / get / grant / ungrant / unregister).',
  subcommands: [create, list, get, grant, ungrant, unregister],
};
