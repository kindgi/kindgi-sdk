// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi license` — a deployment renews its own license key, when you run
 * it: by hand, or from your own scheduler (cron, CI, a scheduled job).
 * Nothing calls Kindgi unless you run `renew`.
 *
 *   - `enroll --for <github login> --renewer <ref>`: once per deployment.
 *     Makes the renewer's key pair, keeps the private half at `<ref>` (it
 *     never leaves it, and is never printed), and prints the line to add on
 *     access.kindgi.com, signed in as that login.
 *   - `renew --key <ref> | --env-file <path>  --renewer <ref>`: asks for the
 *     key's next version, checks it offline, and writes it only when it's
 *     new. One line by shape; exit 1 when refused or failed, so a
 *     scheduler's alerting sees it.
 *
 * `<ref>`: `file:<path>`, `env-file:<path>#<NAME>`,
 * `gcp:projects/<project>/secrets/<name>`,
 * `azure:https://<vault>.vault.azure.net/secrets/<name>`,
 * `aws:<region>:<name>` (`license/stores.ts`).
 */

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import type { LicenseClaims } from '../license/license-key.js';
import {
  KINDGI_ACCESS_ORIGIN,
  decodeRenewerPrivateKey,
  encodeRenewerPrivateKey,
  enrollLine,
  generateRenewerKey,
} from '../license/protocol.js';
import { renewLicense } from '../license/renew.js';
import {
  SecretRefError,
  type SecretStore,
  runCloudCli,
  secretStoreFor,
} from '../license/stores.js';
import { commandResultFromThrown, stringFlag } from './helpers.js';
import type { CommandResult, GroupCommand, LeafCommand } from './types.js';

/** A GitHub login: letters, digits and single hyphens, up to 39. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const DAY_MS = 86_400_000;
/** From this many days before it expires, the runtime warns, and so does `renew`. */
const WARN_DAYS = 30;

function store(ctx: CommandContext, flag: string, ref: string): SecretStore {
  try {
    return secretStoreFor(ref, {
      cwd: ctx.cwd,
      cloud: { fetch: ctx.fetch, env: ctx.env, run: runCloudCli },
    });
  } catch (cause) {
    if (cause instanceof SecretRefError) throw new UsageError(`--${flag}: ${cause.message}`);
    throw cause;
  }
}

/** `--access-url`: https, or http to this machine (a local instance); access.kindgi.com by default. */
function accessOrigin(ctx: CommandContext): string {
  const raw = stringFlag(ctx, 'access-url') ?? KINDGI_ACCESS_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--access-url must be a URL. Got "${raw}".`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.pathname !== '/') {
    throw new UsageError(
      `--access-url must be the service's origin over https (http only on this machine), like ${KINDGI_ACCESS_ORIGIN}. Got "${raw}".`,
    );
  }
  return url.origin;
}

function required(ctx: CommandContext, flag: string, what: string): string {
  const value = stringFlag(ctx, flag);
  if (value === undefined) throw new UsageError(`--${flag} is required: ${what}.`);
  return value;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

const enroll: LeafCommand = {
  kind: 'leaf',
  name: 'enroll',
  description:
    'Enroll this deployment to renew its license key: makes its renewer key (kept at --renewer, never printed) and prints the line to add on access.kindgi.com.',
  usage:
    'kindgi license enroll --for <github login> --renewer <ref> [--access-url <origin>] [--replace]',
  optionSpec: {
    for: {
      type: 'string',
      description:
        'The GitHub login you sign in to access.kindgi.com with: the line is for it alone.',
    },
    renewer: {
      type: 'string',
      description:
        "Where to keep the renewer's private key: file:<path>, env-file:<path>#<NAME>, gcp:…, azure:…, aws:….",
    },
    'access-url': {
      type: 'string',
      description: 'Another instance of the service (default https://access.kindgi.com).',
    },
    replace: {
      type: 'boolean',
      description:
        'Make a new renewer key even if --renewer already holds one (the old one stops working once you add the new line).',
    },
  },
  async run(ctx): Promise<CommandResult> {
    try {
      const login = required(ctx, 'for', 'the GitHub login you sign in to access.kindgi.com with');
      if (!GITHUB_LOGIN.test(login))
        throw new UsageError(`--for must be a GitHub login. Got "${login}".`);
      const renewerRef = required(ctx, 'renewer', "where to keep the renewer's private key");
      const origin = accessOrigin(ctx);
      const where = store(ctx, 'renewer', renewerRef);
      const existing = await where.read();
      const kept = existing === undefined ? undefined : decodeRenewerPrivateKey(existing);
      if (existing !== undefined && kept === undefined && ctx.options.replace !== true) {
        throw new UsageError(
          `${where.describe} already holds something that isn't a renewer key: name another place, or pass --replace to overwrite it.`,
        );
      }
      const reuse = kept !== undefined && ctx.options.replace !== true;
      const key = reuse ? kept : generateRenewerKey();
      if (!reuse) await where.write(encodeRenewerPrivateKey(key));
      const stdout = [
        `Renewer ${key.renewerId}: its private key is ${reuse ? 'already ' : ''}in ${where.describe}.`,
        '',
        `Add this deployment on ${origin}, signed in as ${login}, under "Renew the key from your deployment":`,
        '',
        `  ${enrollLine(key, login, origin)}`,
        '',
        'Then renew the key whenever you like, by hand or on your own schedule:',
        '',
        `  kindgi license renew --key <where the license key is> --renewer ${renewerRef}${origin === KINDGI_ACCESS_ORIGIN ? '' : ` --access-url ${origin}`}`,
        '',
      ].join('\n');
      return { kind: 'ok', rendered: { stdout, stderr: '' } };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'license enroll');
    }
  },
};

function describeKey(claims: LicenseClaims): string {
  return `${claims.name}'s ${claims.use} key, until ${day(claims.expiresAt)}`;
}

const renew: LeafCommand = {
  kind: 'leaf',
  name: 'renew',
  description:
    "Renew this deployment's license key: asks access.kindgi.com for the next one, checks it offline, and writes it only when it's new.",
  usage:
    'kindgi license renew (--key <ref> | --env-file <path>) --renewer <ref> [--access-url <origin>]',
  optionSpec: {
    key: {
      type: 'string',
      description:
        'Where the license key is kept, and the new one goes: file:…, env-file:…#NAME, gcp:…, azure:…, aws:….',
    },
    'env-file': {
      type: 'string',
      description: 'Shorthand for --key env-file:<path>#KINDGI_LICENSE_KEY (a kindgi.env).',
    },
    renewer: {
      type: 'string',
      description: "Where the renewer's private key is (as enroll was given).",
    },
    'access-url': {
      type: 'string',
      description: 'Another instance of the service (default https://access.kindgi.com).',
    },
  },
  async run(ctx): Promise<CommandResult> {
    try {
      const keyFlag = stringFlag(ctx, 'key');
      const envFile = stringFlag(ctx, 'env-file');
      if ((keyFlag === undefined) === (envFile === undefined)) {
        throw new UsageError(
          'Give --key <ref> or --env-file <path> (one of them): where the license key is.',
        );
      }
      const keyRef = keyFlag ?? `env-file:${envFile}#KINDGI_LICENSE_KEY`;
      const renewerRef = required(
        ctx,
        'renewer',
        "where the renewer's private key is (as enroll was given)",
      );
      const origin = accessOrigin(ctx);
      const outcome = await renewLicense(
        { key: store(ctx, 'key', keyRef), renewer: store(ctx, 'renewer', renewerRef), origin },
        { fetch: ctx.fetch, ...(ctx.licenseDeps?.renew ?? {}) },
      );
      if (outcome.kind === 'refused') {
        return {
          kind: 'error',
          stderr: `refused (${outcome.error}): ${outcome.message}\n`,
          exitCode: 1,
        };
      }
      if (outcome.kind === 'failed')
        return { kind: 'error', stderr: `${outcome.message}\n`, exitCode: 1 };
      const now = (ctx.licenseDeps?.renew?.now ?? Date.now)();
      const daysLeft = Math.floor((outcome.claims.expiresAt.getTime() - now) / DAY_MS);
      const lines = [
        `${outcome.kind}: ${describeKey(outcome.claims)} (renewer ${outcome.renewerId})`,
        ...(daysLeft <= WARN_DAYS
          ? [
              `⚠ It expires in ${daysLeft} days. If renew keeps answering unchanged, sign in at ${origin} for a new key.`,
            ]
          : []),
      ];
      return { kind: 'ok', rendered: { stdout: `${lines.join('\n')}\n`, stderr: '' } };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'license renew');
    }
  },
};

export const licenseCommand: GroupCommand = {
  kind: 'group',
  name: 'license',
  description:
    'Your Kindgi license key: enroll a deployment once, then renew its key when you run renew (by hand or on your own schedule).',
  subcommands: [enroll, renew],
};
