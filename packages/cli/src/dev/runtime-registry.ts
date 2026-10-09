// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Docker's access to the registry the Kindgi runtime image comes from, for
 * `kindgi auth registry`: `docker login` (the credential goes to Docker's
 * own credential store; Kindgi keeps no copy), then a check that the
 * pinned image can be pulled.
 *
 * Every step runs `docker` through the runner `kindgi dev` uses
 * (`runtime-container.ts`), handed in, so tests pass a fake.
 */

import type { DockerOutcome, DockerRunner } from './runtime-container.js';
import { RUNTIME_ACCESS_URL, RUNTIME_IMAGE_REGISTRY, registryOf } from './runtime-image.js';

/** How a registry, or Docker relaying it, refuses credentials or access. */
const AUTH_FAILURE =
  /unauthorized|denied|forbidden|authentication required|insufficient_scope|no basic auth credentials/i;

/** Whether `docker` output says the registry refused the credentials (or their absence). */
export function isRegistryAuthFailure(output: string): boolean {
  return AUTH_FAILURE.test(output);
}

/**
 * Docker couldn't run the credential helper its config names (`credsStore`
 * or `credHelpers` in `~/.docker/config.json`): `docker login`, `pull` and
 * the access check all fail on it, whatever the registry would say.
 */
const CREDENTIAL_HELPER_FAILURE =
  /error (?:getting|storing|saving) credentials|docker-credential-[A-Za-z0-9._-]+[^\n]*(?:executable file not found|not found in \$PATH)/i;

/**
 * The credential helper `docker` output says it couldn't run: `{ helper }`
 * (`desktop` for `docker-credential-desktop`, when named), or `undefined`
 * when the output isn't about one.
 */
export function credentialHelperFailure(output: string): { readonly helper?: string } | undefined {
  if (!CREDENTIAL_HELPER_FAILURE.test(output)) return undefined;
  const helper = /docker-credential-([A-Za-z0-9._-]+)/.exec(output)?.[1];
  return helper !== undefined ? { helper } : {};
}

/** What to do about a credential helper Docker couldn't run. */
export function credentialHelperHint(helper: string | undefined): string {
  const name = helper !== undefined ? `docker-credential-${helper}` : 'a credential helper';
  return `Docker's config (~/.docker/config.json, or the one in $DOCKER_CONFIG: "credsStore" or "credHelpers") names ${name}, and Docker couldn't run it. Put it on your PATH (Docker Desktop on macOS keeps it in /Applications/Docker.app/Contents/Resources/bin), or remove that entry from the config, then run this again.`;
}

/** The command that logs Docker in to `image`'s registry, as a message shows it. */
export function registryLoginCommand(image: string): string {
  const registry = registryOf(image);
  const other = registry === RUNTIME_IMAGE_REGISTRY ? '' : ` --registry ${registry}`;
  return `kindgi auth registry --username <the robot name you were given>${other}`;
}

/** The end of what `docker` wrote to stderr, with `secret` (the token) blanked out. */
function detail(outcome: DockerOutcome, secret?: string): string {
  const text =
    secret === undefined || secret === ''
      ? outcome.stderr
      : outcome.stderr.split(secret).join('***');
  return text.trim().split('\n').slice(-5).join('\n');
}

export type DockerCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly message: string };

/** Docker is installed and its engine answers: the login and the pull both need it. */
export async function checkDocker(run: DockerRunner): Promise<DockerCheck> {
  const version = await run(['version', '--format', '{{.Server.Version}}']);
  if (version.code === null) {
    return {
      kind: 'error',
      message: `Docker isn't installed, or \`docker\` isn't on your PATH (${detail(version)}).\n  kindgi dev runs the Kindgi runtime in Docker: install Docker Desktop (or a Docker engine on Linux), then run this again.`,
    };
  }
  if (version.code !== 0) {
    return {
      kind: 'error',
      message: `Docker isn't running: ${detail(version)}\n  Start Docker Desktop (or the Docker engine), then run this again.`,
    };
  }
  return { kind: 'ok' };
}

export type RegistryLogin =
  | {
      readonly kind: 'ok';
      /** What `docker login` warned about (an unencrypted credential store), line by line. */
      readonly notes: readonly string[];
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * `docker login <registry> --username <username> --password-stdin`, with
 * the token written to its stdin: never in its arguments, its
 * environment, or a message.
 */
export async function dockerLogin(
  run: DockerRunner,
  registry: string,
  username: string,
  token: string,
): Promise<RegistryLogin> {
  const login = await run(['login', registry, '--username', username, '--password-stdin'], {
    stdin: token,
  });
  if (login.code === 0) {
    const notes = detail(login, token);
    return { kind: 'ok', notes: notes === '' ? [] : notes.split('\n') };
  }
  const helper = credentialHelperFailure(login.stderr);
  const refused =
    helper !== undefined
      ? `\n  ${credentialHelperHint(helper.helper)}`
      : isRegistryAuthFailure(login.stderr)
        ? `\n  Check the username and the token.${registry === RUNTIME_IMAGE_REGISTRY ? ` For new pull credentials, sign in at ${RUNTIME_ACCESS_URL}.` : ''}`
        : '';
  return {
    kind: 'error',
    message: `docker login ${registry} failed: ${detail(login, token)}${refused}`,
  };
}

/** How the check reached the registry: buildx, or the fallback when buildx isn't installed. */
export type AccessMethod = 'docker buildx imagetools inspect' | 'docker manifest inspect';

export type ImageAccess =
  | { readonly kind: 'ok'; readonly method: AccessMethod }
  /** The registry refused: no credentials, or credentials without access. */
  | { readonly kind: 'no-access'; readonly detail: string; readonly method: AccessMethod }
  /**
   * The image isn't there, or the registry can't be reached. With
   * `docker manifest inspect`, "no such manifest" is also what a registry
   * that refuses an anonymous caller looks like: `maybeNoAccess`.
   */
  | {
      readonly kind: 'not-found';
      readonly detail: string;
      readonly method: AccessMethod;
      readonly maybeNoAccess?: true;
    }
  /** Docker couldn't run the credential helper its config names (`helper`, when named). */
  | {
      readonly kind: 'credential-helper';
      readonly helper?: string;
      readonly detail: string;
      readonly method: AccessMethod;
    }
  /** Neither `docker buildx` nor `docker manifest` is available. */
  | { readonly kind: 'no-tool'; readonly detail: string };

/** `docker` saying a command (a plugin such as buildx) isn't installed. */
const UNKNOWN_COMMAND = /is not a docker command|unknown command/i;

/**
 * Whether Docker's credentials on this machine can pull `image`, without
 * pulling it: `docker buildx imagetools inspect` fetches the manifest by
 * its digest, as `docker pull` does.
 *
 * Without buildx (a bare Linux engine often lacks it), `docker manifest
 * inspect` on the digest-only reference instead. Never on the full
 * `name:tag@digest`: it resolves that by its tag, so a moved tag fails it
 * while the pinned digest still pulls.
 */
export async function checkImageAccess(run: DockerRunner, image: string): Promise<ImageAccess> {
  const inspected = await run(['buildx', 'imagetools', 'inspect', image]);
  if (!UNKNOWN_COMMAND.test(inspected.stderr) || inspected.code === 0) {
    return accessFrom(inspected, 'docker buildx imagetools inspect');
  }
  // `--insecure` only where Docker itself allows plain HTTP by default
  // (loopback): `docker manifest` doesn't follow the engine's settings.
  const insecure = isLoopbackRegistry(registryOf(image)) ? ['--insecure'] : [];
  const manifest = await run(['manifest', 'inspect', ...insecure, digestOnly(image)]);
  if (manifest.code !== 0 && UNKNOWN_COMMAND.test(manifest.stderr)) {
    return { kind: 'no-tool', detail: `${detail(inspected)}\n${detail(manifest)}` };
  }
  return accessFrom(manifest, 'docker manifest inspect');
}

function accessFrom(outcome: DockerOutcome, method: AccessMethod): ImageAccess {
  if (outcome.code === 0) return { kind: 'ok', method };
  const shown = detail(outcome);
  const helper = credentialHelperFailure(outcome.stderr);
  if (helper !== undefined) return { kind: 'credential-helper', ...helper, detail: shown, method };
  if (isRegistryAuthFailure(outcome.stderr)) return { kind: 'no-access', detail: shown, method };
  return {
    kind: 'not-found',
    detail: shown,
    method,
    ...(method === 'docker manifest inspect' &&
      /no such manifest/i.test(outcome.stderr) && { maybeNoAccess: true as const }),
  };
}

/** `repo:tag@sha256:…` → `repo@sha256:…`; a reference without a digest is unchanged. */
export function digestOnly(image: string): string {
  const at = image.indexOf('@');
  if (at === -1) return image;
  const name = image.slice(0, at);
  const colon = name.lastIndexOf(':');
  const repo = colon > name.lastIndexOf('/') ? name.slice(0, colon) : name;
  return `${repo}${image.slice(at)}`;
}

function isLoopbackRegistry(registry: string): boolean {
  const host = registry.startsWith('[')
    ? registry.slice(0, registry.indexOf(']') + 1)
    : registry.split(':')[0];
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host ?? '');
}
