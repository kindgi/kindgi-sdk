// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { saveHomeConfig } from '../config.js';
import type { CommandContext } from '../context.js';
import { type DockerRunner, docker } from '../dev/runtime-container.js';
import {
  DEFAULT_RUNTIME_IMAGE,
  RUNTIME_ACCESS_URL,
  RUNTIME_IMAGE_REGISTRY,
  imageOnRegistry,
  registryOf,
} from '../dev/runtime-image.js';
import {
  type AccessMethod,
  type ImageAccess,
  checkDocker,
  checkImageAccess,
  credentialHelperHint,
  dockerLogin,
  registryLoginCommand,
} from '../dev/runtime-registry.js';
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
    const path = await saveHomeConfig({ apiUrl: url, token }, ctx.home);
    return {
      kind: 'ok',
      rendered: renderJson({ ok: true, wrote: path, apiUrl: url }, ctx.globals.format),
    };
  },
};

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
  description:
    "Log Docker in to the runtime image's registry, then check it can pull the image kindgi dev runs.",
  usage:
    'kindgi auth registry [--username <name>] [--password-stdin] [--check] [--registry <host>]',
  optionSpec: {
    username: {
      type: 'string',
      description: 'The robot name you were given with your pull token. Needed to log in.',
    },
    'password-stdin': {
      type: 'boolean',
      description: 'Read the token from stdin instead of prompting for it.',
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
  /** Set unless `check`. */
  readonly username: string | undefined;
  /** The registry to log in to. */
  readonly host: string;
}

function registryArgs(ctx: CommandContext): RegistryArgs | (CommandResult & { kind: 'error' }) {
  const check = ctx.options.check === true;
  const fromStdin = ctx.options['password-stdin'] === true;
  const username = ctx.options.username;
  const registryFlag = ctx.options.registry;
  if (typeof registryFlag === 'string' && !REGISTRY_HOST.test(registryFlag)) {
    return usageError(
      `--registry takes a registry host, such as ${RUNTIME_IMAGE_REGISTRY} or 127.0.0.1:5000, not "${registryFlag}".`,
    );
  }
  if (check && (username !== undefined || fromStdin)) {
    return usageError('--check only checks access, so it takes no --username or --password-stdin.');
  }
  if (!check && (typeof username !== 'string' || username === '')) {
    return usageError(
      `Missing --username=<name>: the robot name that comes with your pull token (get yours at ${RUNTIME_ACCESS_URL}, signed in with GitHub).\nTo check access without logging in: kindgi auth registry --check.`,
    );
  }
  return {
    check,
    fromStdin,
    username: typeof username === 'string' ? username : undefined,
    host: typeof registryFlag === 'string' ? registryFlag : RUNTIME_IMAGE_REGISTRY,
  };
}

async function runRegistry(ctx: CommandContext): Promise<CommandResult> {
  const args = registryArgs(ctx);
  if ('kind' in args) return args;
  const seam = ctx.registryAuthSeam ?? {};
  const run = seam.docker ?? docker;
  // The pinned image, or the same image on the registry named instead.
  const pinned = imageOnRegistry(DEFAULT_RUNTIME_IMAGE, args.host);
  const image = seam.image ?? pinned;

  const ready = await checkDocker(run);
  if (ready.kind === 'error') return { kind: 'error', stderr: `${ready.message}\n`, exitCode: 1 };

  const lines: string[] = [];
  if (args.username !== undefined) {
    const prompt = `Token for ${args.username} at ${args.host}: `;
    const token = await readToken(seam, args.fromStdin, prompt);
    if (token.kind === 'error') return token;
    const login = await dockerLogin(run, args.host, args.username, token.token);
    if (login.kind === 'error') return { kind: 'error', stderr: `${login.message}\n`, exitCode: 1 };
    lines.push(
      `  ✓ Logged in to ${args.host} as ${args.username}. Docker keeps the credential in its own credential store; Kindgi stores nothing.`,
      ...login.notes.map((note) => `    docker: ${note}`),
    );
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
        ? `    The runtime image is in private preview: get pull credentials at ${RUNTIME_ACCESS_URL} (sign in with GitHub), then log in: ${registryLoginCommand(image)}.`
        : `    ${args.username} is logged in to ${args.host} but can't pull it: sign in at ${RUNTIME_ACCESS_URL} for current pull credentials.`,
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

type TokenRead =
  | { readonly kind: 'ok'; readonly token: string }
  | (CommandResult & { kind: 'error' });

/**
 * The token: all of stdin with `--password-stdin`, otherwise a hidden
 * prompt. It goes only to `docker login`'s stdin.
 */
async function readToken(
  seam: RegistryAuthSeam,
  fromStdin: boolean,
  prompt: string,
): Promise<TokenRead> {
  let raw: TokenRead;
  if (fromStdin) {
    try {
      raw = { kind: 'ok', token: await (seam.readStdin ?? readStdinToEnd)() };
    } catch (err) {
      return {
        kind: 'error',
        stderr: `Couldn't read the token from stdin: ${(err as Error).message}\n`,
        exitCode: 1,
      };
    }
  } else {
    raw = await promptToken(seam, prompt);
  }
  if (raw.kind === 'error') return raw;
  // As `docker login --password-stdin` reads it: a trailing newline isn't part of it.
  const token = raw.token.replace(/\r?\n$/, '');
  if (token === '') return { kind: 'error', stderr: 'Empty token refused.\n', exitCode: 1 };
  return { kind: 'ok', token };
}

/** The hidden prompt, on a terminal only. */
async function promptToken(seam: RegistryAuthSeam, prompt: string): Promise<TokenRead> {
  if (!(seam.stdinIsTty ?? stdinIsTty)()) {
    return {
      kind: 'error',
      stderr: 'No terminal to prompt for the token on: pass it on stdin with --password-stdin.\n',
      exitCode: 1,
    };
  }
  const tty = seam.tty ?? realTtySeam();
  try {
    return { kind: 'ok', token: await tty.promptHidden(prompt) };
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
