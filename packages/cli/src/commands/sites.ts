// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Site, SiteCollectionPage, SiteEnrollmentCode, SitesClient } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { renderJson } from '../output.js';
import {
  type TableSpec,
  integerFlag,
  listFlag,
  projectIdFlag,
  readJsonInput,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

type Settings = Parameters<SitesClient['update']>[2];

const PROJECT_FLAG: Readonly<Record<string, ParseArgsOption>> = {
  project: {
    type: 'string',
    description: "The site's project, by id (default: the tenant's Default project).",
  },
};

/** The settings `register` and `update` both take; each says its own default. */
const SETTING_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  name: {
    type: 'string',
    description:
      'How Kindgi shows the people the site signs in: "Jane, via <name>". Only a tenant admin sets it, never the site. At most 100 characters.',
  },
  origin: {
    type: 'string',
    description:
      "The site's origin, as the plugin's Kindgi → Settings page shows it (`https://acme-store.example`): https, no path. `http://` only for localhost, 127.0.0.1 or [::1].",
  },
  'approvals-url': {
    type: 'string',
    description:
      "Where an approval opens on the site, with `{approvalId}` in it, on the site's origin: the plugin's Kindgi → Settings page shows it. The site's people get it in their reviewer email.",
  },
  'allowed-role': {
    type: 'string',
    multiple: true,
    description:
      "A role on the site that may sign in at all (a WordPress role: `shop_manager`); repeat for each (at most 20). Any other role is refused. Without --role-map, the role map keeps only these roles' entries: the default map's on register, the site's own on update.",
  },
  'role-map': {
    type: 'string',
    description:
      'For each allowed role, what it gets in the project, as JSON or `@<file>`: `{"shop_manager": {"ask": true, "reviewer": "standard"}}`. `ask`: whether it may start turns with the agents; `reviewer`: `standard` or `senior` (at most --reviewer-ceiling), or absent to decide no approvals.',
  },
  'reviewer-ceiling': {
    type: 'string',
    description: "The highest reviewer role the site's people can have: `standard` or `senior`.",
  },
  vouching: {
    type: 'string',
    description: "`on` or `off`: whether the site's sign-ins are taken at all.",
  },
  'people-cap': {
    type: 'string',
    description: 'At most this many live people from the site (1 to 10000).',
  },
  'new-people-per-day': {
    type: 'string',
    description: 'At most this many new people from the site a day (1 to 1000).',
  },
};

const SETTING_USAGE =
  '[--allowed-role=<role> ...] [--role-map=<json-or-@file>] [--reviewer-ceiling=standard|senior] [--vouching=on|off] [--people-cap=<n>] [--new-people-per-day=<n>] [--project=<project-id>]';

/** The settings given on the command line; none given is `{}`. */
async function settingsFrom(ctx: CommandContext): Promise<Settings> {
  const displayName = stringFlag(ctx, 'name');
  const origin = stringFlag(ctx, 'origin');
  const approvalsUrl = stringFlag(ctx, 'approvals-url');
  const allowedRoles = listFlag(ctx, 'allowed-role');
  const roleMap = stringFlag(ctx, 'role-map');
  const reviewerCeiling = stringFlag(ctx, 'reviewer-ceiling');
  if (
    reviewerCeiling !== undefined &&
    reviewerCeiling !== 'standard' &&
    reviewerCeiling !== 'senior'
  ) {
    throw new Error('--reviewer-ceiling must be `standard` or `senior`');
  }
  const vouching = stringFlag(ctx, 'vouching');
  if (vouching !== undefined && vouching !== 'on' && vouching !== 'off') {
    throw new Error('--vouching must be `on` or `off`');
  }
  const peopleCap = integerFlag(ctx, 'people-cap');
  const newPeoplePerDay = integerFlag(ctx, 'new-people-per-day');
  return {
    ...(displayName !== undefined && { displayName }),
    ...(origin !== undefined && { origin }),
    ...(approvalsUrl !== undefined && { approvalsUrl }),
    ...(allowedRoles.length > 0 && { allowedRoles }),
    ...(roleMap !== undefined && {
      roleMap: (await readJsonInput(roleMap)) as NonNullable<Settings['roleMap']>,
    }),
    ...(reviewerCeiling !== undefined && { reviewerCeiling }),
    ...(vouching !== undefined && { vouching: vouching === 'on' }),
    ...(peopleCap !== undefined && { peopleCap }),
    ...(newPeoplePerDay !== undefined && { newPeoplePerDay }),
  };
}

/** Where the code goes, said once: what the plugin's admin pastes. */
function codeNote(ctx: CommandContext, code: SiteEnrollmentCode): string[] {
  return [
    `  One-time code (shown this once; it works until ${code.expiresAt}): ${code.code}`,
    `  In WordPress, under Kindgi → Settings, paste the address WordPress reaches Kindgi at (this CLI uses ${ctx.apiUrl()}) and the code.`,
  ];
}

function state(s: Site): string {
  if (s.unregisteredAt !== undefined) return 'unregistered';
  if (s.pausedAt !== undefined) return 'paused';
  if (s.keys.length === 0) return 'not connected';
  return s.vouching ? 'signing in' : 'not vouching';
}

const SITES_TABLE: TableSpec<SiteCollectionPage, Site> = {
  rows: (p) => p.data,
  columns: [
    { header: 'ID', get: (s) => s.siteId },
    { header: 'NAME', get: (s) => s.displayName },
    { header: 'ORIGIN', get: (s) => s.origin },
    { header: 'STATE', get: state },
    { header: 'KEYS', get: (s) => String(s.keys.length) },
  ],
};

const register: LeafCommand = {
  kind: 'leaf',
  name: 'register',
  description:
    "Register a site that signs its own people in to a project (the Kindgi WordPress plugin), and get its one-time code, shown once. The site's people ask the project's agents and decide its approvals as themselves, as the site vouches for them. Tenant admins only.",
  usage: `kindgi sites register --name=<shown name> --origin=<https://…> --approvals-url=<url with {approvalId}> ${SETTING_USAGE}`,
  optionSpec: { ...SETTING_FLAGS, ...PROJECT_FLAG },
  run: (ctx) =>
    runSdkRendered(ctx, 'sites register', async () => {
      const settings = await settingsFrom(ctx);
      const { displayName, origin, approvalsUrl } = settings;
      if (displayName === undefined || origin === undefined || approvalsUrl === undefined) {
        throw new Error(
          "--name=<shown name>, --origin=<https://…> and --approvals-url=<url> are required: the plugin's Kindgi → Settings page shows the origin and the approvals URL",
        );
      }
      const projectId = await projectIdFlag(ctx);
      const { site, enrollment } = await ctx
        .client()
        .projects.sites.register(projectId, { ...settings, displayName, origin, approvalsUrl });
      const rendered = renderJson({ site, enrollment }, ctx.globals.format);
      return {
        stdout: rendered.stdout,
        stderr: [
          '',
          `  Registered site ${site.siteId} on project ${site.projectId}: its people show as "<name>, via ${site.displayName}".`,
          ...codeNote(ctx, enrollment),
          `  A code that ran out: \`kindgi sites code ${site.siteId}${projectSuffix(ctx)}\` gives a new one.`,
          '',
          '',
        ].join('\n'),
      };
    }),
};

/** `--project=<id>` again in a suggested command, when it was given. */
function projectSuffix(ctx: CommandContext): string {
  const project = stringFlag(ctx, 'project');
  return project !== undefined ? ` --project=${project}` : '';
}

const code: LeafCommand = {
  kind: 'leaf',
  name: 'code',
  description:
    "A new one-time code for a site, shown once: to connect it again, or to replace its key. When the site connects with it, its new key replaces every key it had and its people's live sessions end. An earlier unused code stops working.",
  usage: 'kindgi sites code <site-id> [--project=<project-id>]',
  optionSpec: PROJECT_FLAG,
  run: (ctx) =>
    runSdkRendered(ctx, 'sites code', async () => {
      const siteId = requiredPositional(ctx, 0, 'site-id');
      const enrollment = await ctx
        .client()
        .projects.sites.newEnrollmentCode(await projectIdFlag(ctx), siteId);
      const rendered = renderJson(enrollment, ctx.globals.format);
      return {
        stdout: rendered.stdout,
        stderr: ['', ...codeNote(ctx, enrollment), '', ''].join('\n'),
      };
    }),
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description: "List a project's sites. Tenant admins only.",
  usage:
    'kindgi sites list [--include-unregistered] [--project=<project-id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    'include-unregistered': { type: 'boolean', description: 'Unregistered sites too.' },
    ...PROJECT_FLAG,
    limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
    cursor: {
      type: 'string',
      description: "Resume after this cursor, from the previous page's `nextCursor`.",
    },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'sites list',
      async () => {
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().projects.sites.list(await projectIdFlag(ctx), {
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
          ...(ctx.options['include-unregistered'] === true && { includeUnregistered: true }),
        });
      },
      SITES_TABLE,
    ),
};

const update: LeafCommand = {
  kind: 'leaf',
  name: 'update',
  description:
    "Change a site's settings; the rest stay as they are. A person's grants follow the new settings the next time the site signs them in. Tenant admins only.",
  usage: `kindgi sites update <site-id> [--name=<shown name>] [--origin=<https://…>] [--approvals-url=<url>] ${SETTING_USAGE}`,
  optionSpec: { ...SETTING_FLAGS, ...PROJECT_FLAG },
  run: (ctx) =>
    runSdk(ctx, 'sites update', async () => {
      const siteId = requiredPositional(ctx, 0, 'site-id');
      const settings = await settingsFrom(ctx);
      if (Object.keys(settings).length === 0) throw new Error('Nothing to change: give a setting');
      return await ctx.client().projects.sites.update(await projectIdFlag(ctx), siteId, settings);
    }),
};

/** A command on one site, answered with the site. */
function bySite(
  name: string,
  description: string,
  call: (sites: SitesClient, projectId: string, siteId: string) => Promise<Site>,
): LeafCommand {
  return {
    kind: 'leaf',
    name,
    description,
    usage: `kindgi sites ${name} <site-id> [--project=<project-id>]`,
    optionSpec: PROJECT_FLAG,
    run: (ctx) =>
      runSdk(ctx, `sites ${name}`, async () => {
        const siteId = requiredPositional(ctx, 0, 'site-id');
        return await call(ctx.client().projects.sites, await projectIdFlag(ctx), siteId);
      }),
  };
}

const revokeKey: LeafCommand = {
  kind: 'leaf',
  name: 'revoke-key',
  description:
    "Revoke one of a site's keys, by its id (`kindgi sites get` lists them, with thumbprints to compare with the plugin's): statements signed with it are refused from now on, and the site's live sessions end. Tenant admins only.",
  usage: 'kindgi sites revoke-key <site-id> <kid> [--project=<project-id>]',
  optionSpec: PROJECT_FLAG,
  run: (ctx) =>
    runSdk(ctx, 'sites revoke-key', async () => {
      const siteId = requiredPositional(ctx, 0, 'site-id');
      const kid = requiredPositional(ctx, 1, 'kid');
      return await ctx.client().projects.sites.revokeKey(await projectIdFlag(ctx), siteId, kid);
    }),
};

const restorePerson: LeafCommand = {
  kind: 'leaf',
  name: 'restore-person',
  description:
    "Let one of a site's people removed in Kindgi back in, by their user id (`kindgi people list --include-removed` finds it): the same person, with their history, and their grants come back the next time the site signs them in. Refused, with nothing changed, for someone who isn't removed, someone their site said left (if they come back, it signs them in as a new person), and someone who also signs in another way. Tenant admins only. Needs a runtime on Kindgi 0.1.10 or later.",
  usage: 'kindgi sites restore-person <site-id> <user-id> [--project=<project-id>]',
  optionSpec: PROJECT_FLAG,
  run: (ctx) =>
    runSdk(ctx, 'sites restore-person', async () => {
      const siteId = requiredPositional(ctx, 0, 'site-id');
      const userId = requiredPositional(ctx, 1, 'user-id');
      return await ctx
        .client()
        .projects.sites.restorePerson(await projectIdFlag(ctx), siteId, userId);
    }),
};

export const sitesCommand: Command = {
  kind: 'group',
  name: 'sites',
  description:
    'Sites that sign their own people in to a project (the Kindgi WordPress plugin): register, code, list, get, update, pause, resume, revoke-key, restore-person, unregister. Tenant admins only.',
  subcommands: [
    register,
    code,
    list,
    bySite('get', "Fetch a site: its settings, and its keys' ids and thumbprints.", (s, p, id) =>
      s.get(p, id),
    ),
    update,
    bySite(
      'pause',
      "Stop a site's sign-ins: its statements are refused until it's resumed, and its people's live sessions end now.",
      (s, p, id) => s.pause(p, id),
    ),
    bySite('resume', "Start a paused site's sign-ins again.", (s, p, id) => s.resume(p, id)),
    revokeKey,
    restorePerson,
    bySite(
      'unregister',
      'Unregister a site: its sign-ins stop and its live sessions end. The people it signed in stay, with their records.',
      (s, p, id) => s.unregister(p, id),
    ),
  ],
};
