// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { UsageError } from '../errors.js';
import { renderJson, successNote } from '../output.js';
import { requiredPositional, runSdk, runSdkRendered, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi sign-in`: the workspace's sign-in settings. Whether signing in
 * takes a second factor covers the deployment's own ways in (the emailed
 * link, and providers like Google, Microsoft and GitHub). Signing in
 * through the workspace's own identity provider (`kindgi sso`) is exempt:
 * it owns MFA there. So are a site's people: the site signs them in and
 * owns their second factor. API keys aren't covered.
 */

const settings: LeafCommand = {
  kind: 'leaf',
  name: 'settings',
  description:
    "The workspace's sign-in settings; `--require-second-factor=on` makes signing in take a second factor (an authenticator app), `off` stops requiring it. Once on, a session made without one ends at its next request, and signing in to the console with an API token is refused. Signing in through the workspace's own identity provider is exempt: it owns MFA there. A site's people sign in through the site, which owns their second factor, so the setting doesn't apply to them. API keys aren't covered: keep them to service accounts, and rotate them. Turning it on when signed in takes a sign-in made with your own second factor. Tenant admins only.",
  usage: 'kindgi sign-in settings [--require-second-factor=on|off]',
  optionSpec: {
    'require-second-factor': {
      type: 'string',
      description: '`on` or `off`: whether signing in takes a second factor.',
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'sign-in settings', async () => {
      const flag = stringFlag(ctx, 'require-second-factor');
      if (flag !== undefined && flag !== 'on' && flag !== 'off') {
        throw new UsageError(`--require-second-factor takes on or off (got ${flag})`);
      }
      const now =
        flag === undefined
          ? await ctx.client().auth.settings.get()
          : await ctx.client().auth.settings.update({ secondFactor: { required: flag === 'on' } });
      const { required, onPreviousSecret, unusable } = now.secondFactor;
      const lines = [
        required
          ? 'Signing in takes a second factor (your own identity provider is exempt; API keys are not covered).'
          : "Signing in doesn't take a second factor.",
        ...(onPreviousSecret > 0
          ? [
              `${onPreviousSecret} person(s)' second factor is still under the previous sign-in secret: keep it configured until this is 0.`,
            ]
          : []),
        ...(unusable > 0
          ? [
              `${unusable} person(s)' second factor can't be read any more: they need a recovery code, or kindgi people reset-second-factor.`,
            ]
          : []),
      ];
      return {
        stdout: renderJson(now, ctx.globals.format).stdout,
        stderr: successNote(ctx.globals.format, `${lines.join('\n')}\n`),
      };
    }),
};

/**
 * `kindgi sign-in join-domains`: the email domains people may join the
 * workspace from. Someone with a verified mailbox at one, signing in by a
 * way that proves it, whom the workspace doesn't have yet, joins with a
 * press. The CLI signs in with an API key, which proves no email: so
 * `allow` takes the deployment operator's key, and a tenant admin allows
 * their own domain from the console. `remove` takes any tenant admin.
 */

type JoinRole = 'viewer' | 'runner' | 'none';

const JOIN_ROLES: readonly JoinRole[] = ['viewer', 'runner', 'none'];

/** What someone who joins by a domain gets, in words. */
function joinerGets(role: JoinRole): string {
  return role === 'none' ? 'with no project role' : `as ${role} on the default project`;
}

const joinList: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    'The email domains people may join this workspace from, the first allowed first, with what a joiner gets. Anyone in the workspace may list them.',
  usage: 'kindgi sign-in join-domains list',
  run: (ctx) =>
    runSdk(
      ctx,
      'sign-in join-domains list',
      async () => await ctx.client().auth.joinDomains.list(),
      {
        rows: (page) => page.data,
        columns: [
          { header: 'DOMAIN', get: (d) => d.domain },
          { header: 'ROLE', get: (d) => d.role },
          { header: 'ALLOWED', get: (d) => d.createdAt },
          { header: 'BY', get: (d) => d.createdBy },
        ],
      },
    ),
};

const joinAllow: LeafCommand = {
  kind: 'leaf',
  name: 'allow',
  description:
    "Let people at an email domain join: someone with a verified mailbox there (a Google Workspace account, a Microsoft work account, or the emailed link; never GitHub) whom the workspace doesn't have yet is offered it at sign-in. Exactly that domain, not its subdomains; never a public mailbox domain like gmail.com. From the CLI it takes the deployment operator's key (one holding `kindgi:system`, on a runtime serving one tenant): an API key proves no email, so a tenant admin allows their own domain from the console's Sign-in page instead.",
  usage: 'kindgi sign-in join-domains allow <domain> [--role=viewer|runner|none]',
  optionSpec: {
    role: {
      type: 'string',
      description:
        'What a joiner gets: `viewer` or `runner` on the default project, or `none`, a member with no project role. Never tenant admin.',
    },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'sign-in join-domains allow', async () => {
      const domain = requiredPositional(ctx, 0, 'domain');
      const role = stringFlag(ctx, 'role');
      if (role !== undefined && !(JOIN_ROLES as readonly string[]).includes(role)) {
        throw new UsageError(`--role takes ${JOIN_ROLES.join(', ')} (got ${role})`);
      }
      const allowed = await ctx
        .client()
        .auth.joinDomains.allow({ domain, ...(role !== undefined && { role: role as JoinRole }) });
      return {
        stdout: renderJson(allowed, ctx.globals.format).stdout,
        stderr: successNote(
          ctx.globals.format,
          `People at ${allowed.domain} may join, ${joinerGets(allowed.role)}.\n`,
        ),
      };
    }),
};

const joinRemove: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description:
    'Stop letting people at an email domain join. New joins stop; the people who joined stay. Any tenant admin.',
  usage: 'kindgi sign-in join-domains remove <domain>',
  run: (ctx) =>
    runSdkRendered(ctx, 'sign-in join-domains remove', async () => {
      const domain = requiredPositional(ctx, 0, 'domain');
      const removed = await ctx.client().auth.joinDomains.unregister(domain);
      return {
        stdout: renderJson(removed, ctx.globals.format).stdout,
        stderr: successNote(
          ctx.globals.format,
          `People at ${removed.domain} can't join any more; the people who joined stay.\n`,
        ),
      };
    }),
};

const joinDomains: Command = {
  kind: 'group',
  name: 'join-domains',
  description: 'The email domains people may join the workspace from.',
  subcommands: [joinList, joinAllow, joinRemove],
};

export const signInCommand: Command = {
  kind: 'group',
  name: 'sign-in',
  description:
    "The workspace's sign-in settings: whether signing in takes a second factor, and the email domains people may join from.",
  subcommands: [settings, joinDomains],
};
