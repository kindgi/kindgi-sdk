// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ListPage,
  ServiceAccount,
  ServiceAccountGrant,
  ServiceAccountGrantInput,
  ServiceAccountGrantTarget,
} from '@kindgi/client';

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
 * `kindgi service-accounts`: named, non-human principals for an app, a
 * pipeline or a schedule, with grants of their own. They act through API
 * keys: `kindgi tokens create --for=sa:<id>`. Tenant admins only.
 */

const PROJECT_ROLES = ['viewer', 'editor', 'owner', 'admin'] as const;
type ProjectRole = (typeof PROJECT_ROLES)[number];

/** `--project=<project-id>:<role>`, repeatable: project grants. */
function projectGrants(ctx: CommandContext): ServiceAccountGrantInput[] {
  return listFlag(ctx, 'project').map((raw) => {
    const colon = raw.lastIndexOf(':');
    const projectId = raw.slice(0, colon);
    const role = raw.slice(colon + 1);
    if (colon <= 0 || !(PROJECT_ROLES as readonly string[]).includes(role)) {
      throw new UsageError(
        `--project must be <project-id>:<role>, the role one of ${PROJECT_ROLES.join(', ')}; got "${raw}"`,
      );
    }
    return { kind: 'project', projectId, role: role as ProjectRole };
  });
}

/** A grant in words: `tenant admin`, `tenant member`, `editor on <project-id>`. */
function grantWords(g: ServiceAccountGrant): string {
  if (g.kind === 'tenant-admin') return 'tenant admin';
  if (g.kind === 'tenant-member') return 'tenant member';
  return `${g.role} on ${g.projectId}`;
}

function grantsCell(a: ServiceAccount): string {
  return a.grants.map(grantWords).join('; ');
}

/** Read the tenant's settings: a service account has it only when granted. */
const TENANT_MEMBER_HELP =
  "Tenant member: read the tenant's settings (providers, policies, adapters, signing keys, deployments), not its projects. Not given by default; give it only to an account whose job needs it.";

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
    "Create a service account with its first grants, written before it answers: a key minted for it works at once. It reads the tenant's settings only with --tenant-member.",
  usage:
    'kindgi service-accounts create <name> [--description=<text>] [--tenant-admin] [--tenant-member] [--project=<project-id>:<role>]…',
  optionSpec: {
    description: { type: 'string', description: 'What it is for.' },
    'tenant-admin': { type: 'boolean', description: 'Make it a tenant admin.' },
    'tenant-member': { type: 'boolean', description: TENANT_MEMBER_HELP },
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
      const grants: ServiceAccountGrantInput[] = [
        ...(ctx.options['tenant-admin'] === true ? [{ kind: 'tenant-admin' } as const] : []),
        ...(ctx.options['tenant-member'] === true ? [{ kind: 'tenant-member' } as const] : []),
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

/** `--tenant-admin`, `--tenant-member`, or `--project=<id>`: exactly one. */
function targetFlags(ctx: CommandContext): ServiceAccountGrantTarget {
  const tenantAdmin = ctx.options['tenant-admin'] === true;
  const tenantMember = ctx.options['tenant-member'] === true;
  const projectId = stringFlag(ctx, 'project');
  if ([tenantAdmin, tenantMember, projectId !== undefined].filter(Boolean).length !== 1) {
    throw new UsageError('Give one of --tenant-admin, --tenant-member or --project=<project-id>');
  }
  if (tenantAdmin) return { kind: 'tenant-admin' };
  if (tenantMember) return { kind: 'tenant-member' };
  return { kind: 'project', projectId: projectId as string };
}

/** A grant: `--tenant-admin`, `--tenant-member`, or `--project=<id>` with `--role`. */
function grantFlags(ctx: CommandContext): ServiceAccountGrantInput {
  const target = targetFlags(ctx);
  if (target.kind !== 'project') return target;
  const role = stringFlag(ctx, 'role');
  if (role === undefined || !(PROJECT_ROLES as readonly string[]).includes(role)) {
    throw new UsageError(`--role must be one of ${PROJECT_ROLES.join(', ')}`);
  }
  return { ...target, role: role as ProjectRole };
}

const grant: LeafCommand = {
  kind: 'leaf',
  name: 'grant',
  description:
    "Grant a service account tenant admin, tenant member (read the tenant's settings), or a role on a project (replacing its role there). Written before it answers.",
  usage:
    'kindgi service-accounts grant <service-account-id> (--tenant-admin | --tenant-member | --project=<project-id> --role=<role>)',
  optionSpec: {
    'tenant-admin': { type: 'boolean', description: 'Tenant admin.' },
    'tenant-member': { type: 'boolean', description: TENANT_MEMBER_HELP },
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
  description:
    'Remove tenant admin, tenant member, or the role on a project, from a service account.',
  usage:
    'kindgi service-accounts ungrant <service-account-id> (--tenant-admin | --tenant-member | --project=<project-id>)',
  optionSpec: {
    'tenant-admin': { type: 'boolean', description: 'Tenant admin.' },
    'tenant-member': { type: 'boolean', description: 'Tenant member.' },
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
