// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { sameAddress } from '../api-address.js';
import { type ResolvedConfig, saveHomeConfig } from '../config.js';
import type { CommandContext } from '../context.js';
import { type DockerRunner, docker } from '../dev/runtime-container.js';
import {
  DEFAULT_RUNTIME_IMAGE,
  KINDGI_REGISTRY,
  KINDGI_REGISTRY_USERNAME,
  RUNTIME_IMAGE_REGISTRY,
  imageOnRegistry,
  isKindgiRegistry,
  registryOf,
} from '../dev/runtime-image.js';
import {
  type AccessMethod,
  type ImageAccess,
  checkDocker,
  checkImageAccess,
  credentialHelperHint,
  dockerLogin,
  pullCredentialNeeded,
  registryLoginCommand,
} from '../dev/runtime-registry.js';
import { LICENSE_KEY_PREFIX, checkLicenseKey } from '../license/license-key.js';
import { KINDGI_ACCESS_ORIGIN } from '../license/protocol.js';
import {
  SecretRefError,
  type SecretStore,
  runCloudCli,
  secretStoreFor,
} from '../license/stores.js';
import { renderJson } from '../output.js';
import {
  PromptCancelled,
  type TtySeam,
  readStdinToEnd,
  realTtySeam,
  stdinIsTty,
} from '../terminal-input.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

const login: LeafCommand = {
  kind: 'leaf',
  name: 'login',
  description: 'Persist an API URL + token to ~/.kindgi/config.json.',
  usage: 'kindgi auth login [--url=<url>] [--token=<token>]',
  optionSpec: {},
  run: async (ctx): Promise<CommandResult> => {
    const url = ctx.globals.url ?? ctx.config.apiUrl;
    const token = ctx.globals.token ?? ctx.config.token;
    if (typeof url !== 'string' || url === '') {
      return {
        kind: 'error',
        stderr: 'Missing --url=<api-url> (or KINDGI_API_URL / existing config).\n',
        exitCode: 2,
      };
    }
    if (typeof token !== 'string' || token === '') {
      return {
        kind: 'error',
        stderr: 'Missing --token=<api-token> (or KINDGI_API_TOKEN / existing config).\n',
        exitCode: 2,
      };
    }
    const elsewhere = storedKeyElsewhere(ctx.config, url);
    if (elsewhere !== undefined) {
      return {
        kind: 'error',
        stderr: `kindgi auth login would save ${elsewhere} as ${url}'s key. A stored key goes only to its own address: give ${url}'s key with --token or KINDGI_API_TOKEN.\n`,
        exitCode: 2,
      };
    }
    const path = await saveHomeConfig({ apiUrl: url, token }, ctx.home);
    return {
      kind: 'ok',
      rendered: renderJson({ ok: true, wrote: path, apiUrl: url }, ctx.globals.format),
    };
  },
};

/**
 * A key login wasn't given (`--token`, KINDGI_API_TOKEN) is a stored one,
 * and login saves it only for its own address: `--url B` alone would make
 * the key for A B's, and send it there from then on. Which key, when it
 * isn't for `url`; `undefined` when login may save it.
 */
function storedKeyElsewhere(config: ResolvedConfig, url: string): string | undefined {
  if (config.source.token !== 'file') return undefined;
  const keyAddress = config.keyAddress;
  if (keyAddress !== undefined && sameAddress(keyAddress, url)) return undefined;
  const file = config.files?.token;
  const stored = file === undefined ? 'the API key stored' : `the API key stored in ${file.path}`;
  return keyAddress === undefined
    ? `${stored}, which has no address stored with it,`
    : `${stored}, which is for ${keyAddress},`;
}

const whoami: LeafCommand = {
  kind: 'leaf',
  name: 'whoami',
  description: 'Verify the configured token by hitting the API.',
  usage: 'kindgi auth whoami',
  run: async (ctx): Promise<CommandResult> => {
    const base = ctx.apiUrl();
    const token = ctx.token();
    // An authenticated route: a wrong or revoked token gets 401, not a pass.
    const url = `${base.replace(/\/+$/, '')}/v1/identity/whoami`;
    try {
      const res = await ctx.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const source = ctx.config.source;
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403
            ? ' (the token is wrong, revoked, or for another server)'
            : '';
        return {
          kind: 'error',
          stderr: `whoami failed: HTTP ${res.status}${hint}\n`,
          exitCode: 1,
        };
      }
      const identity = (await res.json()) as Record<string, unknown>;
      return {
        kind: 'ok',
        rendered: renderJson(
          {
            ok: true,
            apiUrl: base,
            tokenSource: source.token,
            apiUrlSource: source.apiUrl,
            identity,
          },
          ctx.globals.format,
        ),
      };
    } catch (err) {
      return {
        kind: 'error',
        stderr: `whoami failed: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }
  },
};

/**
 * Injectable seams for `kindgi auth registry`, so tests drive the login
 * and the check without Docker, a terminal or stdin. Each defaults to
 * the real one.
 */
export interface RegistryAuthSeam {
  /** Runs `docker`. Default: the runner `kindgi dev` uses. */
  readonly docker?: DockerRunner;
  /** Reads all of stdin (`--password-stdin`). */
  readonly readStdin?: () => Promise<string>;
  /** Whether stdin is a terminal, which the hidden prompt needs. */
  readonly stdinIsTty?: () => boolean;
  /** The hidden prompt for the token. */
  readonly tty?: TtySeam;
  /**
   * The image the check looks for. Default: the image this CLI runs (on
   * `--registry`, when given). Tests point it at a registry of their own.
   */
  readonly image?: string;
}

/** A registry host, with an optional port: `quay.io`, `127.0.0.1:5000`, `[::1]:5000`. */
const REGISTRY_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(?::\d+)?$/;

const registry: LeafCommand = {
  kind: 'leaf',
  name: 'registry',
  description: `Log Docker in to the runtime image's registry (on ${KINDGI_REGISTRY}, with your license key), then check it can pull the image kindgi dev runs.`,
  usage:
    'kindgi auth registry [--key-from <store> | --password-stdin] [--username <name>] [--check] [--registry <host>]',
  optionSpec: {
    username: {
      type: 'string',
      description: `Your username on another registry, such as your pull credential's robot name (shown at ${KINDGI_ACCESS_ORIGIN} once you sign in with GitHub). Not needed on ${KINDGI_REGISTRY}, which takes your license key.`,
    },
    'password-stdin': {
      type: 'boolean',
      description:
        'Read the license key (on another registry, the token) from stdin instead of prompting for it.',
    },
    'key-from': {
      type: 'string',
      description: `Read the license key from where it's kept, as kindgi license renew does: file:…, env-file:…#NAME, gcp:…, azure:…, aws:…. For ${KINDGI_REGISTRY} only.`,
    },
    check: {
      type: 'boolean',
      description: 'Only check that Docker can pull the image, without logging in.',
    },
    registry: {
      type: 'string',
      description: `The registry to log in to, such as a mirror; the check then looks for the image there. Default: the runtime image's registry (\`${RUNTIME_IMAGE_REGISTRY}\`).`,
    },
  },
  run: (ctx) => runRegistry(ctx),
};

interface RegistryArgs {
  /** `--check`: no login, only the check. */
  readonly check: boolean;
  readonly fromStdin: boolean;
  /** `--key-from`: where the license key is kept. */
  readonly keyFrom: SecretStore | undefined;
  /** Set unless `check`. */
  readonly username: string | undefined;
  /** The registry to log in to. */
  readonly host: string;
  /** `host` is Kindgi's registry: the password is the license key. */
  readonly withKey: boolean;
}

function registryArgs(ctx: CommandContext): RegistryArgs | (CommandResult & { kind: 'error' }) {
  const check = ctx.options.check === true;
  const fromStdin = ctx.options['password-stdin'] === true;
  const username = ctx.options.username;
  const keyFrom = ctx.options['key-from'];
  const registryFlag = ctx.options.registry;
  if (typeof registryFlag === 'string' && !REGISTRY_HOST.test(registryFlag)) {
    return usageError(
      `--registry takes a registry host, such as ${RUNTIME_IMAGE_REGISTRY} or 127.0.0.1:5000, not "${registryFlag}".`,
    );
  }
  const given = typeof registryFlag === 'string' ? registryFlag : RUNTIME_IMAGE_REGISTRY;
  // Kindgi's registry, however it was typed, is logged in to by its own
  // name: the host the pinned image names, so its pull finds the login.
  const host = isKindgiRegistry(given) ? KINDGI_REGISTRY : given;
  const withKey = host === KINDGI_REGISTRY;
  const conflict = flagConflict({ check, fromStdin, username, keyFrom, host });
  if (conflict !== undefined) return conflict;
  const named = typeof username === 'string' && username !== '' ? username : undefined;
  if (!check && !withKey && named === undefined) {
    return usageError(
      `Missing --username=<name>: your pull credential's robot name. Sign in with GitHub at ${KINDGI_ACCESS_ORIGIN}: the page shows this command with your robot name, and the token to paste.\nTo check access without logging in: kindgi auth registry --check.`,
    );
  }
  const store = typeof keyFrom === 'string' ? keyStore(ctx, keyFrom) : undefined;
  if (store !== undefined && 'kind' in store) return store;
  return {
    check,
    fromStdin,
    keyFrom: store,
    username: check ? undefined : (named ?? KINDGI_REGISTRY_USERNAME),
    host,
    withKey,
  };
}

/** A flag that doesn't go with the others, or with the registry: its usage error. */
function flagConflict(flags: {
  readonly check: boolean;
  readonly fromStdin: boolean;
  readonly username: unknown;
  readonly keyFrom: unknown;
  readonly host: string;
}): (CommandResult & { kind: 'error' }) | undefined {
  const { check, fromStdin, keyFrom, host } = flags;
  if (check && (flags.username !== undefined || fromStdin || keyFrom !== undefined)) {
    return usageError(
      '--check only checks access, so it takes no --username, --password-stdin or --key-from.',
    );
  }
  if (keyFrom !== undefined && fromStdin) {
    return usageError('--key-from and --password-stdin both give the license key: use one.');
  }
  if (keyFrom !== undefined && host !== KINDGI_REGISTRY) {
    return usageError(
      `--key-from reads a license key, which logs in to ${KINDGI_REGISTRY} only. ${host} takes its own username and token: --username, with --password-stdin or the prompt.`,
    );
  }
  return undefined;
}

/** `--key-from`'s store; a usage error when the reference names none. */
function keyStore(
  ctx: CommandContext,
  ref: string,
): SecretStore | (CommandResult & { kind: 'error' }) {
  try {
    return secretStoreFor(ref, {
      cwd: ctx.cwd,
      cloud: { fetch: ctx.fetch, env: ctx.env, run: runCloudCli },
    });
  } catch (cause) {
    if (cause instanceof SecretRefError) return usageError(`--key-from: ${cause.message}`);
    throw cause;
  }
}

async function runRegistry(ctx: CommandContext): Promise<CommandResult> {
  const args = registryArgs(ctx);
  if ('kind' in args) return args;
  const seam = ctx.registryAuthSeam ?? {};
  const run = seam.docker ?? docker;
  // The pinned image, or the same image on the registry named instead.
  const pinned = imageOnRegistry(DEFAULT_RUNTIME_IMAGE, args.host);
  const image = seam.image ?? pinned;

  const ready = await checkDocker(run, 'kindgi auth registry');
  if (ready.kind === 'error') return { kind: 'error', stderr: `${ready.message}\n`, exitCode: 1 };

  const lines: string[] = [];
  if (args.username !== undefined) {
    const login = await logIn(run, seam, args, args.username);
    if (login.kind === 'error') return login;
    lines.push(...login.lines);
  }

  const access = await checkImageAccess(run, image);
  const how = access.kind === 'no-tool' ? [] : checkedWith(access.method, ctx.globals.verbose);
  if (access.kind !== 'ok') {
    const why = accessFailure(access, image, args);
    return { kind: 'error', stderr: `${[...lines, ...why, ...how].join('\n')}\n`, exitCode: 1 };
  }
  lines.push(`  ✓ You can pull ${image}${whichImage(image, pinned, args.host)}.`, ...how);

  const summary = {
    ok: true,
    registry: args.host,
    loggedIn: !args.check,
    ...(args.username !== undefined && { username: args.username }),
    image,
    checkedWith: access.method,
  };
  return {
    kind: 'ok',
    rendered: {
      stdout: ctx.globals.formatRequested ? renderJson(summary, ctx.globals.format).stdout : '',
      stderr: `${lines.join('\n')}\n`,
    },
  };
}

/**
 * The login: the token (or license key) read, then `docker login` with it
 * as `username`. What it says, line by line.
 */
async function logIn(
  run: DockerRunner,
  seam: RegistryAuthSeam,
  args: RegistryArgs,
  username: string,
): Promise<{ readonly kind: 'ok'; readonly lines: readonly string[] } | TokenReadError> {
  const secret = args.withKey
    ? await readKey(seam, args)
    : await readToken(seam, args.fromStdin, {
        noun: 'token',
        prompt: `Token for ${username} at ${args.host}: `,
      });
  if (secret.kind === 'error') return secret;
  const login = await dockerLogin(run, args.host, username, secret.token);
  if (login.kind === 'error') return { kind: 'error', stderr: `${login.message}\n`, exitCode: 1 };
  const from = args.keyFrom !== undefined ? ` from ${args.keyFrom.describe}` : '';
  return {
    kind: 'ok',
    lines: [
      args.withKey
        ? `  ✓ Logged in to ${args.host} with your license key${from}. Docker keeps it in its own credential store; Kindgi stores nothing. When your key renews, log in again with the new one.`
        : `  ✓ Logged in to ${args.host} as ${username}. Docker keeps the credential in its own credential store; Kindgi stores nothing.`,
      ...login.notes.map((note) => `    docker: ${note}`),
    ],
  };
}

/**
 * Which command checked the image: said when it's the fallback (no
 * buildx), or with `--verbose`.
 */
function checkedWith(method: AccessMethod, verbose: boolean): string[] {
  if (method === 'docker manifest inspect') {
    return ["    Checked with docker manifest inspect: docker buildx isn't installed."];
  }
  return verbose ? [`    Checked with ${method}.`] : [];
}

/** What the checked image is to this CLI, after its reference. */
function whichImage(image: string, pinned: string, host: string): string {
  if (image === DEFAULT_RUNTIME_IMAGE) return ', the image this CLI runs';
  if (image === pinned) {
    return `, the image this CLI runs, from ${host}. Run it with kindgi dev --runtime-image ${image}`;
  }
  return '';
}

/** Why the check failed, and what to do: no access (ask for it), or not found (the image or the network). */
function accessFailure(
  access: Exclude<ImageAccess, { kind: 'ok' }>,
  image: string,
  args: RegistryArgs,
): string[] {
  if (access.kind === 'no-access') {
    return [
      `  ✗ No access to ${image}: ${access.detail}`,
      args.username === undefined
        ? `    ${pullCredentialNeeded(image)}, then log in: ${registryLoginCommand(image)}.`
        : args.withKey
          ? `    Your license key logged in to ${args.host} but can't pull it: sign in at ${KINDGI_ACCESS_ORIGIN} for a current key, then log in again (questions: contact@kindgi.com).`
          : `    ${args.username} is logged in to ${args.host} but can't pull it: sign in at ${KINDGI_ACCESS_ORIGIN} for your current pull credential (questions: contact@kindgi.com).`,
    ];
  }
  if (access.kind === 'credential-helper') {
    return [
      `  ✗ Couldn't check ${image}: ${access.detail}`,
      `    ${credentialHelperHint(access.helper)}`,
    ];
  }
  if (access.kind === 'not-found') {
    const from = registryOf(image);
    return [
      `  ✗ Couldn't find ${image}: ${access.detail}`,
      access.maybeNoAccess === true
        ? `    docker manifest inspect says this both when the image isn't on ${from} and when Docker has no access to it: if you haven't logged in, ${registryLoginCommand(image)}. Otherwise check this machine can reach ${from}.`
        : `    Either the image isn't on ${from}, or this machine can't reach ${from} (the network, a proxy or a firewall).`,
    ];
  }
  return [
    `  ✗ Couldn't check ${image}: neither docker buildx nor docker manifest is available:`,
    ...access.detail.split('\n').map((line) => `    ${line}`),
    '    Docker Desktop includes buildx; on Linux, install the docker-buildx-plugin package.',
  ];
}

function usageError(message: string): CommandResult & { kind: 'error' } {
  return { kind: 'error', stderr: `${message}\n`, exitCode: 2 };
}

type TokenReadError = CommandResult & { kind: 'error' };

type TokenRead = { readonly kind: 'ok'; readonly token: string } | TokenReadError;

/** What the login reads: its name in messages, and the prompt for it. */
interface Secret {
  readonly noun: 'token' | 'license key';
  readonly prompt: string;
}

/**
 * The license key, for Kindgi's registry: from `--key-from`'s store, from
 * stdin, or from a hidden prompt. Only a value that isn't a key at all is
 * refused here; whether the key pulls is the registry's to say, since a
 * key can be signed with a key this CLI is too old to know.
 */
async function readKey(seam: RegistryAuthSeam, args: RegistryArgs): Promise<TokenRead> {
  const store = args.keyFrom;
  const read =
    store === undefined
      ? await readToken(seam, args.fromStdin, {
          noun: 'license key',
          prompt: `License key for ${args.host}: `,
        })
      : await readStoredKey(store);
  if (read.kind === 'error') return read;
  const key = read.token.trim();
  const check = checkLicenseKey(key);
  if (check.kind === 'err' && check.reason === 'malformed') {
    const what = store === undefined ? 'That' : `The value in ${store.describe}`;
    return {
      kind: 'error',
      stderr: `${what} isn't a license key (one starts with ${LICENSE_KEY_PREFIX}). Sign in at ${KINDGI_ACCESS_ORIGIN}: the page shows yours.\n`,
      exitCode: 1,
    };
  }
  return { kind: 'ok', token: key };
}

/** The license key kept in `store`. It goes only to `docker login`'s stdin. */
async function readStoredKey(store: SecretStore): Promise<TokenRead> {
  let value: string | undefined;
  try {
    value = await store.read();
  } catch (err) {
    return {
      kind: 'error',
      stderr: `Couldn't read the license key from ${store.describe}: ${(err as Error).message}\n`,
      exitCode: 1,
    };
  }
  if (value === undefined) {
    return {
      kind: 'error',
      stderr: `There's no license key in ${store.describe}. Sign in at ${KINDGI_ACCESS_ORIGIN} for yours, and keep it there.\n`,
      exitCode: 1,
    };
  }
  return { kind: 'ok', token: value };
}

/**
 * The token (or license key): all of stdin with `--password-stdin`,
 * otherwise a hidden prompt. It goes only to `docker login`'s stdin.
 */
async function readToken(
  seam: RegistryAuthSeam,
  fromStdin: boolean,
  secret: Secret,
): Promise<TokenRead> {
  let raw: TokenRead;
  if (fromStdin) {
    try {
      raw = { kind: 'ok', token: await (seam.readStdin ?? readStdinToEnd)() };
    } catch (err) {
      return {
        kind: 'error',
        stderr: `Couldn't read the ${secret.noun} from stdin: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }
  } else {
    raw = await promptToken(seam, secret);
  }
  if (raw.kind === 'error') return raw;
  // As `docker login --password-stdin` reads it: a trailing newline isn't part of it.
  const token = raw.token.replace(/\r?\n$/, '');
  if (token === '')
    return { kind: 'error', stderr: `Empty ${secret.noun} refused.\n`, exitCode: 1 };
  return { kind: 'ok', token };
}

/** The hidden prompt, on a terminal only. */
async function promptToken(seam: RegistryAuthSeam, secret: Secret): Promise<TokenRead> {
  if (!(seam.stdinIsTty ?? stdinIsTty)()) {
    const store = secret.noun === 'license key' ? ", or say where it's kept with --key-from" : '';
    return {
      kind: 'error',
      stderr: `No terminal to prompt for the ${secret.noun} on: pass it on stdin with --password-stdin${store}.\n`,
      exitCode: 1,
    };
  }
  const tty = seam.tty ?? realTtySeam();
  try {
    return { kind: 'ok', token: await tty.promptHidden(secret.prompt) };
  } catch (err) {
    if (err instanceof PromptCancelled) {
      return { kind: 'error', stderr: 'Cancelled.\n', exitCode: 1 };
    }
    throw err;
  } finally {
    tty.close();
  }
}

export const authCommand: Command = {
  kind: 'group',
  name: 'auth',
  description: "Manage local auth: the API's URL and token, and the runtime image's registry.",
  subcommands: [login, whoami, registry],
};
