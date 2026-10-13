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

import { KindgiApiError } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { LICENSE_WARN_DAYS, isSelfServe } from '../license/expiry.js';
import type { LicenseClaims } from '../license/license-key.js';
import {
  KINDGI_ACCESS_ORIGIN,
  type RenewalUsage,
  decodeRenewerPrivateKey,
  encodeRenewerPrivateKey,
  enrollLine,
  generateRenewerKey,
} from '../license/protocol.js';
import { type CountsSent, renewLicense } from '../license/renew.js';
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

/**
 * `--runtime <url>` with `--runtime-token <ref>`: the deployment's runtime and
 * where its own token is (`KINDGI_API_TOKEN`), to read its use since the
 * current key was issued (`GET /v1/license/usage`). Both or neither.
 */
function runtimeUsage(ctx: CommandContext): ((since: Date) => Promise<RenewalUsage>) | undefined {
  const runtime = stringFlag(ctx, 'runtime');
  const tokenRef = stringFlag(ctx, 'runtime-token');
  if ((runtime === undefined) !== (tokenRef === undefined)) {
    throw new UsageError(
      'Give --runtime <url> and --runtime-token <ref> together: the runtime, and where its own token (KINDGI_API_TOKEN) is kept.',
    );
  }
  if (runtime === undefined || tokenRef === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(runtime);
  } catch {
    throw new UsageError(`--runtime must be a URL. Got "${runtime}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`--runtime must be an http(s) URL. Got "${runtime}".`);
  }
  const tokens = store(ctx, 'runtime-token', tokenRef);
  return async (since) => {
    const token = (await tokens.read())?.trim();
    if (token === undefined || token === '') {
      throw new Error(`there's no token in ${tokens.describe}`);
    }
    try {
      return await ctx.clientFor(url.origin, token).license.usage({ since });
    } catch (cause) {
      throw new Error(usageProblem(url.origin, cause));
    }
  };
}

/** Why the runtime gave no counts, in a line: its refusal, an older runtime, or no answer. */
function usageProblem(runtime: string, cause: unknown): string {
  if (cause instanceof KindgiApiError) {
    if (cause.error.code === 'not-found') {
      return `${runtime} doesn't report its use (a runtime before 0.1.8)`;
    }
    return `${runtime} answered: ${cause.error.message}`;
  }
  return `${runtime} couldn't be asked (${cause instanceof Error ? cause.message : String(cause)})`;
}

/** The counts line, when a runtime was asked. */
function countsLine(counts: CountsSent | undefined): string[] {
  if (counts === undefined) return [];
  if (!counts.sent) {
    return [`counts: not sent (${counts.reason}); this renewal goes without them.`];
  }
  const u = counts.usage;
  const production =
    u.projectsInProduction === undefined ? '' : `, ${u.projectsInProduction} in production`;
  return [
    `counts: sent (${u.runs} runs, ${u.people} people${production} since ${day(new Date(u.since))}, runtime ${u.runtimeVersion})`,
  ];
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
    'kindgi license renew (--key <ref> | --env-file <path>) --renewer <ref> [--runtime <url> --runtime-token <ref>] [--access-url <origin>]',
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
    runtime: {
      type: 'string',
      description:
        "This deployment's runtime: the renewal carries its use since the current key was issued (counts only), read with --runtime-token.",
    },
    'runtime-token': {
      type: 'string',
      description:
        "Where the runtime's own token (KINDGI_API_TOKEN) is kept: file:…, env-file:…#NAME, gcp:…, azure:…, aws:….",
    },
  },
  async run(ctx): Promise<CommandResult> {
    try {
      const usage = runtimeUsage(ctx);
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
        {
          key: store(ctx, 'key', keyRef),
          renewer: store(ctx, 'renewer', renewerRef),
          origin,
          ...(usage !== undefined && { usage }),
        },
        { fetch: ctx.fetch, ...(ctx.licenseDeps?.renew ?? {}) },
      );
      if (outcome.kind === 'refused') {
        return {
          kind: 'error',
          stderr: [...countsLine(outcome.counts), `refused (${outcome.error}): ${outcome.message}`]
            .map((l) => `${l}\n`)
            .join(''),
          exitCode: 1,
        };
      }
      if (outcome.kind === 'failed')
        return { kind: 'error', stderr: `${outcome.message}\n`, exitCode: 1 };
      const now = (ctx.licenseDeps?.renew?.now ?? Date.now)();
      const daysLeft = Math.floor((outcome.claims.expiresAt.getTime() - now) / DAY_MS);
      // A key Kindgi issued is renewed when Kindgi extends its term; a
      // self-serve one, in its last 30 days. By its subject, as `kindgi
      // doctor` and the runtime's banner tell them apart (`isSelfServe`).
      // A sign-in leaves a key this deployment renews to it, so the renewer
      // is stopped first (the page's Renewing deployments).
      const nextKey = isSelfServe(outcome.claims.subject)
        ? `stop this deployment's renewer at ${origin}, then sign in there for a new key`
        : 'write to contact@kindgi.com to extend the term';
      const lines = [
        `${outcome.kind}: ${describeKey(outcome.claims)} (renewer ${outcome.renewerId})`,
        ...countsLine(outcome.counts),
        ...(outcome.kind === 'renewed'
          ? [
              'The runtime uses the new key from its next start; until then it runs on the one it started with.',
            ]
          : []),
        ...(daysLeft <= LICENSE_WARN_DAYS
          ? // The deploy modules' alerts match "It expires in <days> days" on this
            // line (deploy/gcp-cloud-run, deploy/azure-container-apps): keep it.
            [`⚠ It expires in ${daysLeft} days. If renew keeps answering unchanged, ${nextKey}.`]
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
