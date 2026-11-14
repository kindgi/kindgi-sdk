// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { sameAddress, storedIn } from '../api-address.js';
import {
  type HomeLogin,
  type ListedLogin,
  type ResolvedConfig,
  keepsProject,
  listHomeLogins,
  readHomeLogin,
  removeHomeLogin,
  saveHomeConfig,
  saveHomeProfile,
} from '../config.js';
import type { CommandContext } from '../context.js';
import { DEV_LICENSE_KEY_VAR } from '../dev/license-key.js';
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
import { licenseKeyHome, saveHomeLicenseKey } from '../license/home-key.js';
import { LICENSE_KEY_PREFIX, checkLicenseKey } from '../license/license-key.js';
import { KINDGI_ACCESS_ORIGIN } from '../license/protocol.js';
import {
  SecretRefError,
  type SecretStore,
  runCloudCli,
  secretStoreFor,
} from '../license/stores.js';
import { type Column, renderJson, renderTable } from '../output.js';
import { heldNames } from '../profiles.js';
import { type SaidLine, note, renderLines, warning } from '../progress-lines.js';
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
  description:
    "Persist an API URL + key to ~/.kindgi/config.json: the login without a name, or with --profile a Kindgi login profile's. Another address's login there is kept unless --force.",
  usage:
    'kindgi auth login [--profile=<name>] [--url=<url>] [--token-stdin | --token=<token>] [--force]',
  optionSpec: {
    'token-stdin': {
      type: 'boolean',
      description:
        'Read the API key from stdin, all of it (one trailing newline is dropped), so it lands in no shell history or `ps`: `printf \'%s\' "$KEY" | kindgi auth login --url <url> --token-stdin`.',
    },
    force: {
      type: 'boolean',
      description:
        "Replace the login ~/.kindgi/config.json holds for another address (with --profile, that profile's): its API key is no longer stored. By default login refuses.",
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const target = await loginTarget(ctx);
    if (target.kind === 'error') return target;
    const { url, token } = target;
    const profile = ctx.config.profile?.name;
    const lost = await loginLost(ctx.home, profile, url, token);
    if (lost !== undefined && ctx.options.force !== true) {
      return { kind: 'error', stderr: keptLogin(lost, url), exitCode: 2 };
    }
    // A profile holds no project: only the login without a name has one to drop.
    const before = profile === undefined ? await readHomeLogin(ctx.home) : undefined;
    const path =
      profile === undefined
        ? await saveHomeConfig({ apiUrl: url, token }, ctx.home)
        : await saveHomeProfile(profile, { apiUrl: url, token }, ctx.home);
    const rendered = renderJson(
      {
        ok: true,
        wrote: path,
        ...(profile !== undefined && { profile }),
        apiUrl: url,
        ...(lost !== undefined && { replaced: { apiUrl: lost.apiUrl ?? null } }),
      },
      ctx.globals.format,
    );
    const warnings = loginWarnings(path, lost, droppedProject(before, url, token));
    if (warnings.length === 0) return { kind: 'ok', rendered };
    return {
      kind: 'ok',
      rendered: { ...rendered, stderr: renderLines(warnings, ctx.globals.format === 'quiet') },
    };
  },
};

/**
 * The address and key login saves: the given ones (`--url`, `--token`,
 * `--token-stdin`), else the resolved config's (under a profile, the
 * profile's own). Refused when one is missing, or when a stored key would
 * be saved for another address.
 */
async function loginTarget(
  ctx: CommandContext,
): Promise<{ readonly kind: 'ok'; readonly url: string; readonly token: string } | TokenReadError> {
  const given = await givenKey(ctx);
  if (given.kind === 'error') return given;
  const url = ctx.globals.url ?? ctx.config.apiUrl;
  const token = given.token ?? ctx.config.token;
  if (typeof url !== 'string' || url === '') {
    return { kind: 'error', stderr: missingAddress(ctx.config), exitCode: 2 };
  }
  if (typeof token !== 'string' || token === '') {
    return { kind: 'error', stderr: missingKey(ctx.config), exitCode: 2 };
  }
  // A key given for login (`--token`, `--token-stdin`) is saved for `url`.
  const elsewhere = given.token === undefined ? storedKeyElsewhere(ctx.config, url) : undefined;
  if (elsewhere === undefined) return { kind: 'ok', url, token };
  const ways =
    ctx.config.profile === undefined
      ? '--token-stdin, --token or KINDGI_API_TOKEN'
      : '--token-stdin or --token';
  return {
    kind: 'error',
    stderr: `kindgi auth login would save ${elsewhere} as ${url}'s key. A stored key goes only to its own address: give ${url}'s key with ${ways}.\n`,
    exitCode: 2,
  };
}

/** The key given for login: `--token`, or all of stdin with `--token-stdin`; none when neither is. */
async function givenKey(
  ctx: CommandContext,
): Promise<{ readonly kind: 'ok'; readonly token?: string } | TokenReadError> {
  if (ctx.options['token-stdin'] !== true) {
    const token = ctx.globals.token;
    return token === undefined ? { kind: 'ok' } : { kind: 'ok', token };
  }
  if (ctx.globals.token !== undefined) {
    return {
      kind: 'error',
      stderr: '--token and --token-stdin both give the key: use one.\n',
      exitCode: 2,
    };
  }
  return readToken(ctx.authLoginSeam ?? {}, true, API_KEY);
}

/**
 * Login's refusal for a missing address. A profile's comes from the
 * profile or `--url`, never KINDGI_API_URL (`--profile` beats it).
 */
function missingAddress(config: ResolvedConfig): string {
  const profile = config.profile?.name;
  if (profile === undefined) {
    return 'Missing --url=<api-url> (or KINDGI_API_URL / existing config).\n';
  }
  if (config.profileBeat?.includes('KINDGI_API_URL') === true) {
    return `kindgi auth login --profile ${profile} doesn't read KINDGI_API_URL: give ${profile}'s address with --url.\n`;
  }
  return `Missing --url=<api-url>: the profile ${profile} has no address stored, and login takes one only from --url.\n`;
}

/**
 * Login's refusal for a missing key. A profile's comes from the profile,
 * `--token-stdin` or `--token`, never KINDGI_API_TOKEN (`--profile` beats
 * it). Never shows a key.
 */
function missingKey(config: ResolvedConfig): string {
  const profile = config.profile?.name;
  if (profile === undefined) {
    return 'Missing the API key: --token-stdin with it on stdin, or --token=<api-token> (or KINDGI_API_TOKEN / existing config).\n';
  }
  if (config.profileBeat?.includes('KINDGI_API_TOKEN') === true) {
    return `kindgi auth login --profile ${profile} doesn't read KINDGI_API_TOKEN: give ${profile}'s key with --token-stdin.\n`;
  }
  return `Missing ${profile}'s key: give it on stdin with --token-stdin, or with --token=<api-token>.\n`;
}

/** A login `kindgi auth login` would replace, as `loginLost` finds it. */
interface LostLogin {
  readonly path: string;
  /** The profile it is; `undefined` for the login without a name. */
  readonly profile?: string;
  readonly apiUrl?: string;
  /** Why the profile's entry can't be used: then it's replaced whatever it holds. */
  readonly problem?: string;
}

/**
 * The login `~/.kindgi/config.json` holds that saving `url`'s would lose:
 * the one without a name, or `profile`'s. That's a key for another
 * address, one with no address stored with it, or a profile's entry that
 * can't be used. `undefined` when there's none, when it's for `url` (a
 * new key for the same address replaces it, as before), or when its key
 * is the one being saved (the same server under another name loses
 * nothing).
 */
async function loginLost(
  home: string | undefined,
  profile: string | undefined,
  url: string,
  token: string,
): Promise<LostLogin | undefined> {
  const stored = await readHomeLogin(home, profile);
  const which = { path: stored.path, ...(profile !== undefined && { profile }) };
  if (stored.problem !== undefined) return { ...which, problem: stored.problem };
  if (stored.token === undefined || stored.token === token) return undefined;
  if (stored.apiUrl !== undefined && sameAddress(stored.apiUrl, url)) return undefined;
  return { ...which, ...(stored.apiUrl !== undefined && { apiUrl: stored.apiUrl }) };
}

function whoseLogin(lost: LostLogin): string {
  const name = lost.profile === undefined ? undefined : `the profile ${lost.profile}`;
  if (lost.problem !== undefined) {
    return `${name ?? 'the login without a name'}, which can't be used (${lost.problem})`;
  }
  if (lost.apiUrl === undefined) return 'an API key with no address stored with it';
  return name === undefined ? `the login for ${lost.apiUrl}` : `${name}'s login for ${lost.apiUrl}`;
}

/** Login's refusal to replace `lost` without --force. */
function keptLogin(lost: LostLogin, url: string): string {
  const replace = 'To replace it, run again with --force.\n';
  if (lost.problem !== undefined) {
    return `${lost.path} holds ${whoseLogin(lost)}. kindgi auth login would replace it with ${url}'s.\n${replace}`;
  }
  const where = lost.profile === undefined ? 'as a profile' : 'under another profile name';
  return `${lost.path} holds ${whoseLogin(lost)}. kindgi auth login would replace it with ${url}'s, and its API key would be lost.\nTo keep both, save ${url}'s login ${where}: \`kindgi auth login --profile <name> --url ${url} --token-stdin\`, with its key on stdin.\n${replace}`;
}

/** What a login said it replaced (--force): a warning, under --quiet too. */
function replacedNote(lost: LostLogin, path: string): string {
  return lost.problem === undefined
    ? `Replaced ${whoseLogin(lost)} in ${path}: its API key is no longer stored.`
    : `Replaced ${whoseLogin(lost)}, in ${path}.`;
}

/**
 * The project stored beside the login this one replaced: it went with that
 * key and address (`keepsProject`). `before` is the login without a name's;
 * `undefined` under a profile.
 */
function droppedProject(
  before: HomeLogin | undefined,
  url: string,
  token: string,
): string | undefined {
  return before?.project !== undefined && !keepsProject(before, { apiUrl: url, token })
    ? before.project
    : undefined;
}

/**
 * What a login warns of, under --quiet too: the login it replaced (a key
 * no longer stored), and the project that was stored with it.
 */
function loginWarnings(
  path: string,
  lost: LostLogin | undefined,
  dropped: string | undefined,
): ReturnType<typeof warning>[] {
  const lines: ReturnType<typeof warning>[] = [];
  if (lost !== undefined) lines.push(warning(`⚠ ${replacedNote(lost, path)}`));
  if (dropped !== undefined) {
    lines.push(
      warning(
        `⚠ Removed project ${dropped} from ${path}: it was stored with the login this one replaced.`,
      ),
    );
  }
  return lines;
}

/**
 * A key login wasn't given (`--token-stdin`, `--token`, KINDGI_API_TOKEN)
 * is a stored one, and login saves it only for its own address: `--url B`
 * alone would make the key for A B's, and send it there from then on.
 * Which key, when it isn't for `url`; `undefined` when login may save it.
 * The caller skips this for a key read from stdin or `--token`.
 */
function storedKeyElsewhere(config: ResolvedConfig, url: string): string | undefined {
  if (config.source.token !== 'file') return undefined;
  const keyAddress = config.keyAddress;
  if (keyAddress !== undefined && sameAddress(keyAddress, url)) return undefined;
  const file = config.files?.token;
  const stored = file === undefined ? 'the API key stored' : storedIn(file);
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
            profile: ctx.config.profile?.name ?? null,
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

/** The seam for `kindgi auth login --token-stdin`, so tests give the key without stdin. */
export interface AuthLoginSeam {
  /** Reads all of stdin (`--token-stdin`). */
  readonly readStdin?: () => Promise<string>;
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
      description: `Your username on another registry, which goes with that registry's own token. Not needed on ${KINDGI_REGISTRY}, which takes your license key.`,
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
      `Missing --username=<name>: ${host} takes its own username and token. ${KINDGI_REGISTRY} takes your license key with no username: for it, leave out --registry ${host}.\nTo check access without logging in: kindgi auth registry --check --registry ${host}.`,
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

  const lines: SaidLine[] = [];
  if (args.username !== undefined) {
    const login = await logIn(run, seam, args, args.username, licenseKeyHome(ctx));
    if (login.kind === 'error') return login;
    lines.push(...login.lines);
  }

  const access = await checkImageAccess(run, image);
  const how = access.kind === 'no-tool' ? [] : checkedWith(access.method, ctx.globals.verbose);
  if (access.kind !== 'ok') {
    const why = accessFailure(access, image, args);
    const said = [...lines.map((l) => l.text), ...why, ...how];
    return { kind: 'error', stderr: `${said.join('\n')}\n`, exitCode: 1 };
  }
  lines.push(
    note(`  ✓ You can pull ${image}${whichImage(image, pinned, args.host)}.`),
    ...how.map(note),
  );

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
      stderr: renderLines(lines, ctx.globals.format === 'quiet'),
    },
  };
}

/**
 * The login: the token (or license key) read, then `docker login` with it
 * as `username`. A license key Kindgi's registry took is kept for
 * `kindgi dev` too (`~/.kindgi/license/license-key`, owner-only): every
 * runtime needs one. What it says, line by line.
 */
async function logIn(
  run: DockerRunner,
  seam: RegistryAuthSeam,
  args: RegistryArgs,
  username: string,
  home: string | undefined,
): Promise<{ readonly kind: 'ok'; readonly lines: readonly SaidLine[] } | TokenReadError> {
  const secret = args.withKey
    ? await readKey(seam, args)
    : await readToken(seam, args.fromStdin, {
        noun: 'token',
        prompt: `Token for ${username} at ${args.host}: `,
      });
  if (secret.kind === 'error') return secret;
  const login = await dockerLogin(run, args.host, username, secret.token);
  if (login.kind === 'error') return { kind: 'error', stderr: `${login.message}\n`, exitCode: 1 };
  // What docker login warned about: said under --quiet too.
  const dockerNotes = login.notes.map((said) => warning(`    docker: ${said}`));
  if (!args.withKey) {
    return {
      kind: 'ok',
      lines: [
        note(
          `  ✓ Logged in to ${args.host} as ${username}. Docker keeps the credential in its own credential store; Kindgi stores nothing.`,
        ),
        ...dockerNotes,
      ],
    };
  }
  const from = args.keyFrom !== undefined ? ` from ${args.keyFrom.describe}` : '';
  const kept = await saveHomeLicenseKey(secret.token, home).then(
    (path) => ({ kind: 'ok' as const, path }),
    (cause: unknown) => ({ kind: 'error' as const, message: (cause as Error).message }),
  );
  return {
    kind: 'ok',
    lines: [
      note(
        kept.kind === 'ok'
          ? `  ✓ Logged in to ${args.host} with your license key${from}. Docker keeps it in its own credential store, and kindgi dev's copy is in ${kept.path}, readable only by you. When your key renews, log in again with the new one.`
          : `  ✓ Logged in to ${args.host} with your license key${from}. Docker keeps it in its own credential store. When your key renews, log in again with the new one.`,
      ),
      ...(kept.kind === 'error'
        ? [
            warning(
              `  ⚠ Couldn't keep the key for kindgi dev: ${kept.message} kindgi dev reads ${DEV_LICENSE_KEY_VAR} from your shell instead.`,
            ),
          ]
        : []),
      ...dockerNotes,
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
          : `    ${args.username} is logged in to ${args.host} but can't pull it: that username needs access to the image on ${args.host}.`,
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

/** What a login reads: its name in messages, and the prompt for it (registry's only). */
interface Secret {
  readonly noun: 'token' | 'license key' | 'API key';
  readonly prompt: string;
}

/** The API key, as `kindgi auth login --token-stdin` reads it: login never prompts. */
const API_KEY: Secret = { noun: 'API key', prompt: 'API key: ' };

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

/** What reading a secret takes: stdin, and for registry's hidden prompt a terminal. */
type SecretInput = Pick<RegistryAuthSeam, 'readStdin' | 'stdinIsTty' | 'tty'>;

/**
 * A secret a login reads: all of stdin with `--password-stdin` (registry)
 * or `--token-stdin` (`kindgi auth login`), otherwise registry's hidden
 * prompt. It goes only where its login puts it: `docker login`'s stdin,
 * or ~/.kindgi/config.json.
 */
async function readToken(
  seam: SecretInput,
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
async function promptToken(seam: SecretInput, secret: Secret): Promise<TokenRead> {
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

const logout: LeafCommand = {
  kind: 'leaf',
  name: 'logout',
  description:
    "Remove a login from ~/.kindgi/config.json: with --profile that Kindgi login profile's, else the one without a name. Its API key is no longer stored.",
  usage: 'kindgi auth logout [--profile=<name>]',
  run: async (ctx): Promise<CommandResult> => {
    const profile = ctx.config.profile?.name;
    const stored = await readHomeLogin(ctx.home, profile);
    const holds =
      profile === undefined
        ? stored.apiUrl !== undefined || stored.token !== undefined
        : stored.held === true;
    if (!holds) {
      return {
        kind: 'error',
        stderr: noLoginToRemove(stored.path, profile, ctx.config),
        exitCode: 2,
      };
    }
    const path = await removeHomeLogin(profile, ctx.home);
    const rendered = renderJson(
      {
        ok: true,
        wrote: path,
        removed: { profile: profile ?? null, apiUrl: stored.apiUrl ?? null },
      },
      ctx.globals.format,
    );
    if (stored.profilesProblem === undefined) return { kind: 'ok', rendered };
    // A `profiles` that isn't an object goes whole: no profile in it could
    // be used. Said under --quiet too, so a name it never held doesn't read
    // as the one removed.
    const whole = warning(
      `⚠ Removed all of \`profiles\` from ${path}: ${stored.profilesProblem}, so no profile in it could be used.`,
    );
    return {
      kind: 'ok',
      rendered: { ...rendered, stderr: renderLines([whole], ctx.globals.format === 'quiet') },
    };
  },
};

/** Logout's refusal when the file holds no such login: it names the profiles it holds. */
function noLoginToRemove(
  path: string,
  profile: string | undefined,
  config: ResolvedConfig,
): string {
  const held = heldNames(config.profiles ?? []);
  return profile === undefined
    ? `${path} holds no login without a name (its profiles: ${held}).\n`
    : `${path} holds no profile named ${profile} (it holds ${held}).\n`;
}

const LOGIN_COLUMNS: readonly Column<ListedLogin>[] = [
  { header: 'PROFILE', get: (l) => l.profile ?? '(none)' },
  { header: 'API URL', get: (l) => l.apiUrl ?? '' },
  { header: 'USABLE', get: (l) => (l.usable ? 'yes' : `no: ${l.problem ?? ''}`) },
];

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    'List the logins ~/.kindgi/config.json holds: the one without a name and each Kindgi login profile, with its address and whether it can be used. Never a key.',
  usage: 'kindgi auth list',
  run: async (ctx): Promise<CommandResult> => {
    const listed = await listHomeLogins(ctx.home);
    if (ctx.globals.format === 'table') {
      const table = renderTable(listed.logins, LOGIN_COLUMNS);
      const unread =
        listed.problem === undefined
          ? ''
          : `${listed.path}: ${listed.problem}, so no profile in it can be used.\n`;
      return { kind: 'ok', rendered: { ...table, stderr: unread } };
    }
    return {
      kind: 'ok',
      rendered: renderJson(
        {
          ok: true,
          file: listed.path,
          logins: listed.logins,
          ...(listed.problem !== undefined && { problem: listed.problem }),
        },
        ctx.globals.format,
      ),
    };
  },
};

export const authCommand: Command = {
  kind: 'group',
  name: 'auth',
  description:
    "Manage local auth: logins (the API's URL and token, without a name or as Kindgi login profiles), and the runtime image's registry.",
  subcommands: [login, logout, list, whoami, registry],
};
