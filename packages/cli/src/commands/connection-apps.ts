// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ConnectionApp, ConnectionAppPage, CreateConnectionAppInput } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { renderJson } from '../output.js';
import { servedEnvOf } from '../value-target.js';
import { confirmRemoval } from './connections.js';
import {
  type TableSpec,
  givenFlag,
  integerFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand } from './types.js';

/**
 * `kindgi connection-apps`: the tenant's registrations at other apps (its
 * Google client, its GitHub App, its texting provider account) that
 * connections go through. Tenant admins only. A registration names its
 * secrets by reference: store the values first with `kindgi secrets set`.
 */

type SecretRef = { readonly envName: string; readonly name: string };

/** An env name, as the runtime takes it. */
const ENV_NAME = /^[a-z][a-z0-9-]{0,62}$/;
/** The longest secret name the runtime takes. */
const MAX_SECRET_NAME = 256;

/**
 * `--<flag>=<env>/<name>`, or `<name>` under the env the runtime serves.
 * A malformed reference is refused without echoing it: a secret's value
 * pasted in by mistake shouldn't land in the terminal's scrollback.
 */
async function secretRef(
  ctx: CommandContext,
  flag: string,
  served: () => Promise<string | undefined>,
): Promise<SecretRef> {
  const raw = stringFlag(ctx, flag);
  if (raw === undefined) throw new UsageError(`Missing required flag: --${flag}=<env>/<name>`);
  const slash = raw.indexOf('/');
  const name = slash < 0 ? raw : raw.slice(slash + 1);
  if (name === '' || name.length > MAX_SECRET_NAME) {
    throw new UsageError(
      `--${flag} must name a secret, <env>/<name>, the name 1 to ${MAX_SECRET_NAME} characters`,
    );
  }
  if (slash >= 0) {
    const envName = raw.slice(0, slash);
    if (!ENV_NAME.test(envName)) {
      throw new UsageError(
        `--${flag}'s env (before the /) must be lowercase letters, digits and hyphens, starting with a letter`,
      );
    }
    return { envName, name };
  }
  const envName = await served();
  if (envName === undefined) {
    throw new UsageError(
      `--${flag} needs its env, <env>/<name>: this runtime doesn't say which env it serves`,
    );
  }
  return { envName, name };
}

/**
 * `--projects=<id>,<id>`: the projects it's for; left out, every project.
 * Given empty (`--projects=$P` with `P` unset) is refused, since read as
 * left out it would serve every project.
 */
function projectsFlag(ctx: CommandContext): string[] | undefined {
  const raw = givenFlag(ctx, 'projects');
  if (raw === undefined) return undefined;
  const ids = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (ids.length === 0) throw new UsageError('--projects names no project');
  return ids;
}

/** A GitHub App's flags, which no other app takes. */
const GITHUB_ONLY = ['github-app-id', 'slug', 'private-key-ref', 'webhook-secret-ref'] as const;

/** A texts registration's flags, which no other app takes. */
const TEXTS_ONLY = ['provider', 'api-key-ref', 'public-key'] as const;

/** The flags of an app that signs in with a client of its own: a texts registration takes none. */
const CLIENT_FLAGS = ['client-id', 'client-secret-ref', 'tenant', ...GITHUB_ONLY] as const;

type TokenInput = NonNullable<CreateConnectionAppInput['token']>;

/** A texts registration's provider account, from its flags. */
async function tokenFor(
  ctx: CommandContext,
  served: () => Promise<string | undefined>,
): Promise<TokenInput> {
  const given = CLIENT_FLAGS.filter((f) => ctx.options[f] !== undefined);
  if (given.length > 0) {
    throw new UsageError(
      `${given.map((f) => `--${f}`).join(', ')}: a texts registration takes none; it takes --provider, --api-key-ref and --public-key`,
    );
  }
  const provider = stringFlag(ctx, 'provider');
  if (provider === undefined) throw new UsageError('Missing required flag: --provider=telnyx');
  const publicKey = stringFlag(ctx, 'public-key');
  if (publicKey === undefined) {
    throw new UsageError(
      "Missing required flag: --public-key=<base64>, the account's public key as the provider shows it",
    );
  }
  return {
    // The server names the providers it serves, and refuses any other.
    provider: provider as TokenInput['provider'],
    apiKey: await secretRef(ctx, 'api-key-ref', served),
    publicKey,
  };
}

/** The registration `add` makes, from its flags. */
async function registrationFor(
  ctx: CommandContext,
  app: string,
): Promise<CreateConnectionAppInput> {
  let servedEnv: Promise<string | undefined> | undefined;
  const served = () => {
    servedEnv ??= servedEnvOf(ctx.client).then((s) => s?.envName);
    return servedEnv;
  };
  const projects = projectsFlag(ctx);
  const common = { app, ...(projects !== undefined && { projects }) };
  if (app === 'texts') return { ...common, token: await tokenFor(ctx, served) };
  const texts = TEXTS_ONLY.filter((f) => ctx.options[f] !== undefined);
  if (texts.length > 0) {
    throw new UsageError(
      `${texts.map((f) => `--${f}`).join(', ')}: only a texts registration takes`,
    );
  }
  const clientId = stringFlag(ctx, 'client-id');
  if (clientId === undefined) throw new UsageError('Missing required flag: --client-id=<id>');
  if (app !== 'github') {
    const given = GITHUB_ONLY.filter((f) => ctx.options[f] !== undefined);
    if (given.length > 0) {
      throw new UsageError(`${given.map((f) => `--${f}`).join(', ')}: only a GitHub App takes`);
    }
    const tenant = givenFlag(ctx, 'tenant');
    return {
      ...common,
      oauth2: {
        clientId,
        clientSecret: await secretRef(ctx, 'client-secret-ref', served),
        ...(tenant !== undefined && { tenant }),
      },
    };
  }
  if (ctx.options.tenant !== undefined) {
    throw new UsageError(
      '--tenant: a GitHub App takes none; only an app that signs people in at a directory of its own does (`microsoft`)',
    );
  }
  const appNumber = integerFlag(ctx, 'github-app-id');
  if (appNumber === undefined) {
    throw new UsageError("Missing required flag: --github-app-id=<n>, the GitHub App's App ID");
  }
  if (appNumber < 1)
    throw new UsageError("--github-app-id is the GitHub App's App ID, a number from 1");
  const slug = stringFlag(ctx, 'slug');
  if (slug === undefined) throw new UsageError('Missing required flag: --slug=<slug>');
  return {
    ...common,
    githubApp: {
      appNumber,
      slug,
      clientId,
      clientSecret: await secretRef(ctx, 'client-secret-ref', served),
      privateKey: await secretRef(ctx, 'private-key-ref', served),
      webhookSecret: await secretRef(ctx, 'webhook-secret-ref', served),
    },
  };
}

const TABLE: TableSpec<ConnectionAppPage, ConnectionApp> = {
  rows: (page) => page.data,
  columns: [
    { header: 'ID', get: (a) => a.appId },
    { header: 'APP', get: (a) => a.app },
    { header: 'LABEL', get: (a) => a.label ?? '' },
    {
      header: 'PROJECTS',
      get: (a) => (a.projects !== undefined ? a.projects.join(', ') : 'every'),
    },
    { header: 'CREATED', get: (a) => String(a.createdAt) },
  ],
};

/** `list --include-removed`: when each was removed, too. */
const TABLE_WITH_REMOVED: TableSpec<ConnectionAppPage, ConnectionApp> = {
  rows: TABLE.rows,
  columns: [
    ...TABLE.columns,
    { header: 'REMOVED', get: (a) => (a.removedAt !== undefined ? String(a.removedAt) : '') },
  ],
};

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "List the workspace's registrations at other apps. Removed ones are left out unless `--include-removed`.",
  usage: 'kindgi connection-apps list [--include-removed] [--limit=<n>] [--cursor=<c>] [--table]',
  optionSpec: {
    'include-removed': {
      type: 'boolean',
      description: 'Removed registrations too, with when (`removedAt`).',
    },
    limit: { type: 'string', description: 'Page size.' },
    cursor: { type: 'string', description: 'The next page, from `nextCursor`.' },
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'connection-apps list',
      async () => {
        const limit = integerFlag(ctx, 'limit');
        const cursor = stringFlag(ctx, 'cursor');
        return await ctx.client().connectionApps.list({
          ...(ctx.options['include-removed'] === true && { includeRemoved: true }),
          ...(limit !== undefined && { limit }),
          ...(cursor !== undefined && { cursor }),
        });
      },
      ctx.options['include-removed'] === true ? TABLE_WITH_REMOVED : TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description:
    'One registration, with the redirect and notices addresses to give the app. Its secrets show as references.',
  usage: 'kindgi connection-apps get <app-id>',
  run: (ctx) =>
    runSdk(ctx, 'connection-apps get', async () =>
      ctx.client().connectionApps.get(requiredPositional(ctx, 0, 'app-id')),
    ),
};

const add: LeafCommand = {
  kind: 'leaf',
  name: 'add',
  description:
    "Register the workspace's app at Google (`google`), Microsoft (`microsoft`, with `--tenant`), GitHub (`github`, with its four GitHub flags) or LinkedIn (`linkedin`), by its client id and the secrets you stored with `kindgi secrets set`; or the texting provider account a number connects through (`texts`, with --provider, --api-key-ref and --public-key). Prints the registration, with the redirect and notices addresses to give the app.",
  usage:
    'kindgi connection-apps add <app> (--client-id=<id> --client-secret-ref=<env>/<name> [--tenant=<directory>] [--github-app-id=<n> --slug=<slug> --private-key-ref=<env>/<name> --webhook-secret-ref=<env>/<name>] | --provider=telnyx --api-key-ref=<env>/<name> --public-key=<base64>) [--projects=<id>,…]',
  optionSpec: {
    'client-id': { type: 'string', description: "The app's OAuth client id." },
    'client-secret-ref': {
      type: 'string',
      description:
        'The secret holding its client secret: `<env>/<name>`, or `<name>` under the env the runtime serves. Not the one sign-in uses: if one app registration serves both, give this one a second client secret under its own name.',
    },
    tenant: {
      type: 'string',
      description:
        "Microsoft: the directory people sign in at: your Directory (tenant) ID or domain for a single-tenant app, or `organizations`, `common` or `consumers` for a multi-tenant one. Required where the app's entry names no default, as Microsoft's doesn't.",
    },
    projects: {
      type: 'string',
      description:
        'The projects whose connections may use it, comma-separated ids. Default: every project.',
    },
    'github-app-id': {
      type: 'string',
      description:
        "GitHub: the GitHub App's App ID, a number. Not a registration's id, which `get` and `remove` take.",
    },
    slug: { type: 'string', description: "GitHub: the GitHub App's slug." },
    'private-key-ref': {
      type: 'string',
      description:
        "GitHub: the secret holding the GitHub App's private key, as --client-secret-ref.",
    },
    'webhook-secret-ref': {
      type: 'string',
      description:
        "GitHub: the secret holding the GitHub App's webhook secret, as --client-secret-ref.",
    },
    provider: {
      type: 'string',
      description: 'Texts: the texting provider the account is at (`telnyx`).',
    },
    'api-key-ref': {
      type: 'string',
      description:
        "Texts: the secret holding the provider account's API key, as --client-secret-ref. The key is used by this registration only: no tool, endpoint, webhook trigger, destination, model provider or other registration may name the same secret.",
    },
    'public-key': {
      type: 'string',
      description:
        "Texts: the account's public key for signed texts, base64 of 32 bytes, as the provider shows it.",
    },
  },
  run: (ctx) =>
    runSdk(ctx, 'connection-apps add', async () => {
      const app = requiredPositional(ctx, 0, 'app');
      return await ctx.client().connectionApps.create(await registrationFor(ctx, app));
    }),
};

const remove: LeafCommand = {
  kind: 'leaf',
  name: 'remove',
  description:
    'Remove a registration. One with live connections is refused unless --with-connections, which disconnects them too. Asks first, unless --yes.',
  usage: 'kindgi connection-apps remove <app-id> [--with-connections] [--yes]',
  optionSpec: {
    'with-connections': {
      type: 'boolean',
      description:
        'Disconnect its live connections too: each withdrawn at the app and its token destroyed.',
    },
    yes: { type: 'boolean', description: "Don't ask first (for scripts)." },
  },
  run: (ctx) =>
    runSdkRendered(ctx, 'connection-apps remove', async () => {
      const appId = requiredPositional(ctx, 0, 'app-id');
      const withConnections = ctx.options['with-connections'] === true;
      const client = ctx.client();
      const ok = await confirmRemoval(ctx, 'connection-apps remove', async () => {
        const a = await client.connectionApps.get(appId);
        const named = a.label !== undefined ? `${a.label} (${a.appId})` : a.appId;
        return withConnections
          ? `Remove the ${a.app} registration ${named}, and disconnect every connection through it?`
          : `Remove the ${a.app} registration ${named}?`;
      });
      if (ok.kind === 'refused') return { stdout: '', stderr: ok.stderr, exitCode: 1 };
      const removed = await client.connectionApps.remove(appId, {
        ...(withConnections && { withConnections }),
      });
      if (ctx.globals.formatRequested) return renderJson(removed, ctx.globals.format);
      const n = removed.connectionsRemoved;
      const disconnected =
        n > 0 ? `, and disconnected its ${n === 1 ? 'connection' : `${n} connections`}` : '';
      return { stdout: `Removed registration ${appId}${disconnected}.\n`, stderr: '' };
    }),
};

export const connectionAppsCommand: Command = {
  kind: 'group',
  name: 'connection-apps',
  description:
    'Registrations at other apps that connections go through; tenant admins only (list / get / add / remove).',
  subcommands: [list, get, add, remove],
};
