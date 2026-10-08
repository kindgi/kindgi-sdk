// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ApiKeyPrincipal, ApiToken, ListPage } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { renderJson } from '../output.js';
import {
  type TableSpec,
  integerFlag,
  listFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi tokens`: API keys. A key acts for one principal, a person or a
 * service account, with that principal's grants. Its role is a ceiling
 * under them, and its project a limit.
 */

/** `--for=user:<id>` or `--for=sa:<id>` (also `service-account:<id>`). */
export function principalFlag(ctx: CommandContext, name = 'for'): ApiKeyPrincipal | undefined {
  const raw = stringFlag(ctx, name);
  if (raw === undefined) return undefined;
  const colon = raw.indexOf(':');
  const kind = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (colon > 0 && id !== '') {
    if (kind === 'user') return { kind: 'user', id };
    if (kind === 'sa' || kind === 'service-account') return { kind: 'service-account', id };
  }
  throw new Error(`--${name} must be user:<id> or sa:<id>, got "${raw}"`);
}

const DURATION_RE = /^(\d+)([dhm])$/;
const UNIT_MS: Readonly<Record<string, number>> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** `--expires=30d|12h|90m` (from now) or an ISO date. */
export function expiresFlag(ctx: CommandContext, now = () => Date.now()): string | undefined {
  const raw = stringFlag(ctx, 'expires');
  if (raw === undefined) return undefined;
  const span = DURATION_RE.exec(raw);
  if (span !== null) {
    const ms = Number(span[1]) * (UNIT_MS[span[2] as string] as number);
    if (ms <= 0) throw new Error('--expires must be in the future');
    return new Date(now() + ms).toISOString();
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`--expires must be like 30d, 12h or 90m, or an ISO date; got "${raw}"`);
  }
  return at.toISOString();
}

const principalCell = (p: ApiKeyPrincipal | undefined) =>
  p === undefined ? '' : `${p.kind === 'user' ? 'user' : 'sa'}:${p.id}`;
const when = (v: unknown) => (v !== undefined ? String(v) : '');

/** `tokens list --table`. */
const TOKENS_TABLE: TableSpec<ListPage<ApiToken>, ApiToken> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (t) => String(t.id) },
    { header: 'FOR', get: (t) => principalCell(t.principal) },
    { header: 'ROLE', get: (t) => t.role },
    { header: 'PROJECT', get: (t) => when(t.projectId) },
    { header: 'LABEL', get: (t) => t.label ?? '' },
    { header: 'CREATED', get: (t) => String(t.createdAt) },
    { header: 'EXPIRES', get: (t) => when(t.expiresAt) },
    { header: 'REVOKED', get: (t) => when(t.revokedAt) },
    { header: 'LAST USED', get: (t) => when(t.lastUsedAt) },
  ],
};

const ROLES = ['member', 'admin'] as const;

const create: LeafCommand = {
  kind: 'leaf',
  name: 'create',
  description:
    'Create an API key, for you or (a tenant admin) for someone else. Its secret is printed once, here: store it now, nothing shows it again. A `member` key takes no admin action on the tenant; a key limited to a project acts only there.',
  usage:
    'kindgi tokens create [--for=user:<id>|sa:<id>] [--role=member|admin] [--project=<project-id>] [--expires=30d|<iso-date>] [--label=<text>] [--capability=<cap>]…',
  optionSpec: {
    for: {
      type: 'string',
      description: 'Whom it acts for: `user:<id>` or `sa:<service-account-id>` (default: you).',
    },
    role: {
      type: 'string',
      description: '`member` (the default) or `admin` (needs a tenant admin, for one).',
    },
    project: { type: 'string', description: 'Limit the key to this project.' },
    expires: {
      type: 'string',
      description: 'When it stops working: `30d`, `12h`, `90m` from now, or an ISO date.',
    },
    label: { type: 'string', description: 'What the key is for, e.g. `ci`.' },
    capability: {
      type: 'string',
      multiple: true,
      description: 'A capability it carries (repeatable); you must hold it.',
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'tokens create', async () => {
      const principal = principalFlag(ctx);
      const role = stringFlag(ctx, 'role');
      if (role !== undefined && !(ROLES as readonly string[]).includes(role)) {
        throw new Error(`--role must be member or admin, got "${role}"`);
      }
      const projectId = stringFlag(ctx, 'project');
      const expiresAt = expiresFlag(ctx);
      const label = stringFlag(ctx, 'label');
      const capabilities = listFlag(ctx, 'capability');
      const created = await ctx.client().tokens.create({
        ...(principal !== undefined && { for: principal }),
        ...(role !== undefined && { role: role as (typeof ROLES)[number] }),
        ...(projectId !== undefined && { projectId: projectId as never }),
        ...(expiresAt !== undefined && { expiresAt: expiresAt as never }),
        ...(label !== undefined && { label }),
        ...(capabilities.length > 0 && { capabilities }),
      });
      return {
        ...renderJson(created, ctx.globals.format),
        stderr: `⚠ The secret of key ${String(created.meta.id)} is shown once, above: store it now.\n`,
      };
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    'List API keys, newest first, revoked ones included; never secrets. A tenant admin sees every key (`--for` narrows to one principal); anyone else, their own.',
  usage: 'kindgi tokens list [--for=user:<id>|sa:<id>] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    for: { type: 'string', description: "Only this principal's keys (tenant admins)." },
    limit: { type: 'string', description: 'The most keys to return.' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'tokens list',
      async () => {
        const principal = principalFlag(ctx);
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().tokens.list({
          ...(principal !== undefined && { principal }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor: cursor as never }),
        });
      },
      TOKENS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'One API key, by id. No secret.',
  usage: 'kindgi tokens get <token-id>',
  run: (ctx) =>
    runSdk(ctx, 'tokens get', async () => {
      const id = requiredPositional(ctx, 0, 'token-id');
      return await ctx.client().tokens.get(id as never);
    }),
};

const revoke: LeafCommand = {
  kind: 'leaf',
  name: 'revoke',
  description: 'Revoke an API key: from its next request on, it is refused.',
  usage: 'kindgi tokens revoke <token-id>',
  run: (ctx) =>
    runSdk(ctx, 'tokens revoke', async () => {
      const id = requiredPositional(ctx, 0, 'token-id');
      await ctx.client().tokens.revoke(id as never);
      return { tokenId: id, revoked: true };
    }),
};

export const tokensCommand: Command = {
  kind: 'group',
  name: 'tokens',
  description:
    'API keys for you, a person or a service account: create (its secret shown once), list, get, revoke.',
  subcommands: [create, list, get, revoke],
};
