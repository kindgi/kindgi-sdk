// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { InviteEmail, ListPage, PersonGrants, User } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { renderJson } from '../output.js';
import {
  type TableSpec,
  integerFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi people`: the tenant's people. A tenant admin adds one (a
 * tenant member: they can read the tenant's settings), gives them a role
 * (a project or team membership, or tenant admin with
 * `kindgi people grant <id> --tenant-admin`) and mints their first key:
 * `kindgi tokens create --for=user:<id>`. A person added with an email is
 * invited where the runtime invites people: they sign in before the
 * invitation expires, or a tenant admin sends it again
 * (`kindgi people invite <id>`).
 */

const TABLE: TableSpec<ListPage<User>, User> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (u) => String(u.userId) },
    { header: 'NAME', get: (u) => u.displayName ?? '' },
    { header: 'EMAIL', get: (u) => u.primaryEmail ?? '' },
    { header: 'STATE', get: (u) => u.invite?.state ?? '' },
    { header: 'ADDED', get: (u) => String(u.createdAt) },
  ],
};

/** `list --include-removed`: when each was removed, too. */
const TABLE_WITH_REMOVED: TableSpec<ListPage<User>, User> = {
  rows: TABLE.rows,
  columns: [
    ...TABLE.columns,
    {
      header: 'REMOVED',
      get: (u) => (u.unregisteredAt !== undefined ? String(u.unregisteredAt) : ''),
    },
  ],
};

/**
 * What became of an invitation's email, in a line, for a person who has
 * one open; nothing for a runtime that doesn't invite, or no invitation.
 */
function inviteLine(person: User, email: InviteEmail | undefined): string {
  if (email === undefined) return '';
  const resend = `kindgi people invite ${String(person.userId)}`;
  const until =
    person.invite !== undefined ? ` before it expires (${String(person.invite.expiresAt)})` : '';
  if (email.sent) {
    return `The invitation went to ${person.primaryEmail ?? 'their email'}: they sign in with it${until}.\n`;
  }
  switch (email.reason) {
    case 'no-email':
      return 'No invitation: they have no email.\n';
    case 'not-requested':
      return `Invited, not emailed (--no-invite): tell them to sign in with ${person.primaryEmail ?? 'their email'}${until}.\n`;
    case 'not-configured':
      return `Invited, but this deployment sends no email: tell them to sign in through a provider with ${person.primaryEmail ?? 'their email'}${until}.\n`;
    case 'capped':
      return `Invited, but the tenant's invitations for today are used up: send it later (${resend}), or tell them to sign in${until}.\n`;
    default:
      return `Invited, but the invitation email didn't go out: send it again (${resend}), or tell them to sign in${until}.\n`;
  }
}

const add: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    "Add a person to the tenant; prints their id. They can read the tenant's settings at once; give them a project role to work on its agents and runs, and their first key (`kindgi tokens create --for=user:<id>`). Where the runtime invites people, one added with an email is invited, and the invitation emailed unless `--no-invite`; it says whether it was. Tenant admins only.",
  usage: 'kindgi people add --name=<display-name> [--email=<email>] [--no-invite]',
  optionSpec: {
    name: { type: 'string', description: 'Their name, as people see it.' },
    email: { type: 'string', description: "Their email; unique among the tenant's people." },
    'no-invite': {
      type: 'boolean',
      description: "Don't email the invitation: you tell them. They're still invited.",
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'people add', async () => {
      const displayName = stringFlag(ctx, 'name');
      if (displayName === undefined) throw new UsageError('--name is required');
      const email = stringFlag(ctx, 'email');
      const created = await ctx.client().users.create({
        displayName,
        ...(email !== undefined && { email }),
        ...(ctx.options['no-invite'] === true && { sendInvite: false }),
      });
      const added = {
        userId: created.userId,
        displayName,
        ...(email !== undefined && { email }),
        ...(created.invite !== undefined && { invite: created.invite }),
        ...(created.inviteEmail !== undefined && { inviteEmail: created.inviteEmail }),
      };
      return {
        stdout: renderJson(added, ctx.globals.format).stdout,
        stderr:
          ctx.globals.format === 'quiet'
            ? ''
            : `Added to the tenant: they can read its settings. Give them a project role to work on its agents and runs, then their first key: kindgi tokens create --for=user:${String(created.userId)}\n${inviteLine(created, created.inviteEmail)}`,
      };
    }),
};

const invite: LeafCommand = {
  kind: 'leaf',
  name: 'invite',
  description:
    "Send a person's invitation again, for one who hasn't signed in yet: it gets a new expiry, and is emailed where the deployment sends email (it says whether it was). Refused for someone who has joined or was never invited. Tenant admins only.",
  usage: 'kindgi people invite <user-id>',
  run: (ctx) =>
    runSdkRendered(ctx, 'people invite', async () => {
      const id = requiredPositional(ctx, 0, 'user-id');
      const renewed = await ctx.client().users.resendInvite(id as never);
      return {
        stdout: renderJson(renewed, ctx.globals.format).stdout,
        stderr: ctx.globals.format === 'quiet' ? '' : inviteLine(renewed.user, renewed.inviteEmail),
      };
    }),
};

const secondFactor: LeafCommand = {
  kind: 'leaf',
  name: 'second-factor',
  description:
    'Whether a person has a second factor set up (an authenticator app), since when, how many recovery codes they have left, and whether the workspace requires one. Tenant admins only.',
  usage: 'kindgi people second-factor <user-id>',
  run: (ctx) =>
    runSdk(ctx, 'people second-factor', async () =>
      ctx.client().users.secondFactor(requiredPositional(ctx, 0, 'user-id') as never),
    ),
};

const resetSecondFactor: LeafCommand = {
  kind: 'leaf',
  name: 'reset-second-factor',
  description:
    "Remove a person's second factor, for a lost phone or lost recovery codes: they're told by email where the deployment sends it, and it's audited. Their sessions stay. Where the workspace requires one, they set one up again at their next sign-in. Tenant admins only, for anyone but themselves: your own you take off on My access, with a code from it.",
  usage: 'kindgi people reset-second-factor <user-id>',
  run: (ctx) =>
    runSdkRendered(ctx, 'people reset-second-factor', async () => {
      const id = requiredPositional(ctx, 0, 'user-id');
      const reset = await ctx.client().users.removeSecondFactor(id as never);
      return {
        stdout: renderJson(reset, ctx.globals.format).stdout,
        stderr:
          ctx.globals.format === 'quiet'
            ? ''
            : reset.removed
              ? `Removed ${id}'s second factor: they set one up again at their next sign-in where the workspace requires one.\n`
              : `${id} had no second factor set up: nothing changed.\n`,
      };
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "List the tenant's people; `--query` matches the start of a name, `--pending` keeps the people invited who haven't signed in yet (STATE: pending or expired). People who were removed are left out unless `--include-removed`.",
  usage:
    'kindgi people list [--query=<name-prefix>] [--pending] [--include-removed] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    query: { type: 'string', description: 'Only names starting with this.' },
    pending: {
      type: 'boolean',
      description: "Only the people invited who haven't signed in yet (`invite`).",
    },
    'include-removed': {
      type: 'boolean',
      description: 'People who were removed too, with when (`unregisteredAt`).',
    },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'people list',
      async () => {
        const query = stringFlag(ctx, 'query');
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().users.list({
          ...(query !== undefined && { query }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor: cursor as never }),
          ...(ctx.options.pending === true && { pending: true }),
          ...(ctx.options['include-removed'] === true && { includeUnregistered: true }),
        });
      },
      ctx.options['include-removed'] === true ? TABLE_WITH_REMOVED : TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description: 'One person, by id.',
  usage: 'kindgi people get <user-id>',
  run: (ctx) =>
    runSdk(ctx, 'people get', async () =>
      ctx.client().users.get(requiredPositional(ctx, 0, 'user-id') as never),
    ),
};

/** `grants --table`: one row per grant, in words. */
const GRANTS_TABLE: TableSpec<PersonGrants, readonly [string, string]> = {
  rows: (g) => [
    ...(g.tenantAdmin === true ? [['tenant', 'admin'] as const] : []),
    ...(g.tenantMember === true ? [['tenant', 'member (reads its settings)'] as const] : []),
    ...g.projects.map((p) => [`project ${p.projectId}`, p.role] as const),
    ...g.teams.map((t) => [`team ${t.teamId}`, t.role] as const),
    ...(g.reviewer !== undefined ? [['reviewer roster', g.reviewer.role] as const] : []),
  ],
  columns: [
    { header: 'WHERE', get: (r) => r[0] },
    { header: 'ROLE', get: (r) => r[1] },
  ],
};

const grants: LeafCommand = {
  kind: 'leaf',
  name: 'grants',
  description:
    "What a person may do, as granted directly: tenant admin, tenant member (reads the tenant's settings), project and team roles, the reviewer roster. A tenant admin reads anyone's; anyone else only their own.",
  usage: 'kindgi people grants <user-id> [--table]',
  run: (ctx) =>
    runSdk(
      ctx,
      'people grants',
      async () => ctx.client().users.grants(requiredPositional(ctx, 0, 'user-id') as never),
      GRANTS_TABLE,
    ),
};

/** Only `--tenant-admin` is granted here: project and team roles are memberships. */
function tenantAdminFlag(ctx: CommandContext): { readonly kind: 'tenant-admin' } {
  if (ctx.options['tenant-admin'] !== true) {
    throw new UsageError(
      "Give --tenant-admin: a person's project and team roles are memberships (`/v1/projects/{id}/memberships`, `/v1/teams/{id}/memberships`)",
    );
  }
  return { kind: 'tenant-admin' };
}

const grant: LeafCommand = {
  kind: 'leaf',
  name: 'grant',
  description:
    'Make a person a tenant admin, before it answers: their next request holds it. Tenant admins only.',
  usage: 'kindgi people grant <user-id> --tenant-admin',
  optionSpec: { 'tenant-admin': { type: 'boolean', description: 'Tenant admin.' } },
  run: (ctx) =>
    runSdk(ctx, 'people grant', async () => {
      const id = requiredPositional(ctx, 0, 'user-id');
      return await ctx.client().users.grant(id as never, tenantAdminFlag(ctx));
    }),
};

const ungrant: LeafCommand = {
  kind: 'leaf',
  name: 'ungrant',
  description:
    'Remove tenant admin from a person. Refused for the only person who holds it (make someone else one first) and for the seed user (unset KINDGI_SEED_USER_ID and restart the runtime first). Tenant admins only.',
  usage: 'kindgi people ungrant <user-id> --tenant-admin',
  optionSpec: { 'tenant-admin': { type: 'boolean', description: 'Tenant admin.' } },
  run: (ctx) =>
    runSdk(ctx, 'people ungrant', async () => {
      const id = requiredPositional(ctx, 0, 'user-id');
      return await ctx.client().users.ungrant(id as never, tenantAdminFlag(ctx));
    }),
};

const remove: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description:
    'Remove a person from the tenant: every API key and session of theirs is revoked, and every role and membership taken away, before it answers (their keys get 401 at once). Their record stays, so their history still says who they were; their email is free again (adding it makes a new person). Refused for yourself, the seed user and the only tenant admin. Tenant admins only.',
  usage: 'kindgi people remove <user-id>',
  run: (ctx) =>
    runSdkRendered(ctx, 'people remove', async () => {
      const id = requiredPositional(ctx, 0, 'user-id');
      const removed = await ctx.client().users.unregister(id as never);
      const who = removed.user.displayName ?? String(removed.user.userId);
      return {
        stdout: renderJson(removed, ctx.globals.format).stdout,
        stderr:
          ctx.globals.format === 'quiet'
            ? ''
            : `Removed ${who}: ${removed.keysRevoked} key(s) and ${removed.sessionsRevoked} session(s) revoked, ${removed.grantsRemoved} role(s) and membership(s) taken away.\n`,
      };
    }),
};

export const peopleCommand: Command = {
  kind: 'group',
  name: 'people',
  description:
    "The tenant's people: add one, send their invitation again, list, get, their grants, tenant admin given or taken (grant / ungrant), their second factor (read, or reset for a lost phone), and remove one.",
  subcommands: [
    add,
    invite,
    list,
    get,
    grants,
    grant,
    ungrant,
    secondFactor,
    resetSecondFactor,
    remove,
  ],
};
