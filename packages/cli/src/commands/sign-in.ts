// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { UsageError } from '../errors.js';
import { renderJson } from '../output.js';
import { runSdkRendered, stringFlag } from './helpers.js';
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
        stderr: ctx.globals.format === 'quiet' ? '' : `${lines.join('\n')}\n`,
      };
    }),
};

export const signInCommand: Command = {
  kind: 'group',
  name: 'sign-in',
  description: "The workspace's sign-in settings: whether signing in takes a second factor.",
  subcommands: [settings],
};
