// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What the CLI says when something around it stops what `kindgi dev`
 * needs: starting `docker`, reaching Docker's socket, a port on
 * `127.0.0.1`, writing the pack's `.kindgi/`. A coding agent's sandbox
 * often does (its instructions say to hand such commands to the person),
 * so each message says what was refused, in the system's own words, and
 * that the person's own terminal is the fix when an agent runs it.
 * Docker that isn't installed or isn't running gets its usual fix too.
 */

import type { DockerOutcome } from './runtime-container.js';

/** The line that ends a refusal: the person's own terminal, for `command`. */
export function ownTerminalFix(command: string): string {
  return `If a coding agent runs this, its sandbox is likely what stops it: run \`${command}\` in your own terminal instead.`;
}

/** How `docker` failed to answer, from how its command ended. */
export type DockerReach =
  /** `docker` isn't on the PATH (`spawn docker ENOENT`). */
  | 'not-installed'
  /** This process couldn't start `docker` at all (`spawn docker EPERM`, `EACCES`). */
  | 'not-started'
  /** Docker's socket refused this process. */
  | 'socket-denied'
  /** Nothing answered on Docker's socket: the engine isn't running, or can't be reached. */
  | 'not-running'
  /** `docker` ran and failed for a reason of its own: its output says. */
  | 'failed';

/**
 * Docker's own words for a socket that refused the caller: "permission
 * denied while trying to connect to the Docker daemon socket" (Linux, a
 * user outside the `docker` group), or the connect's own error.
 */
const SOCKET_DENIED =
  /permission denied while trying to connect to the docker (?:daemon|api)|connect: (?:permission denied|operation not permitted)/i;

/** Docker's words for an engine that doesn't answer, across its versions and platforms. */
const NOT_RUNNING =
  /cannot connect to the docker daemon|is the docker daemon running|failed to connect to the docker api|error during connect/i;

/** How a `docker` command that didn't succeed failed to answer. */
export function dockerReach(outcome: DockerOutcome): DockerReach {
  if (outcome.code === null) {
    const code = outcome.errorCode ?? /\b(E[A-Z]+)\b/.exec(outcome.stderr)?.[1];
    return code === undefined || code === 'ENOENT' ? 'not-installed' : 'not-started';
  }
  if (SOCKET_DENIED.test(outcome.stderr)) return 'socket-denied';
  if (NOT_RUNNING.test(outcome.stderr)) return 'not-running';
  return 'failed';
}

/** The end of what `docker` wrote to stderr: what it said last. */
function detail(outcome: DockerOutcome): string {
  return outcome.stderr.trim().split('\n').slice(-5).join('\n');
}

/**
 * Why Docker can't be used, for `command` to print: a first line, then the
 * fix on its own line. `undefined` for `failed`, whose own output the
 * caller shows with what it was doing.
 */
export function dockerUnreachable(outcome: DockerOutcome, command: string): string | undefined {
  switch (dockerReach(outcome)) {
    case 'not-installed':
      return `Docker isn't installed, or \`docker\` isn't on your PATH (${detail(outcome)}).\n  kindgi dev runs the Kindgi runtime in Docker: install Docker Desktop (or a Docker engine on Linux), then run this again.`;
    case 'not-started':
      return `\`${command}\` couldn't start \`docker\` (${detail(outcome)}).\n  ${ownTerminalFix(command)} Otherwise, check that the \`docker\` on your PATH can run.`;
    case 'socket-denied':
      return `Docker's socket refused \`${command}\`: ${detail(outcome)}\n  ${ownTerminalFix(command)} Otherwise, your user needs access to Docker (on Linux, the \`docker\` group, or rootless Docker).`;
    case 'not-running':
      return `Docker isn't running, or \`${command}\` can't reach it: ${detail(outcome)}\n  Start Docker Desktop (or the Docker engine), then run this again. If it's running, a coding agent's sandbox may be what keeps it out of reach: run \`${command}\` in your own terminal instead.`;
    case 'failed':
      return undefined;
  }
}

/** The system's refusals: an operation this process isn't allowed (not a missing file or a taken port). */
const REFUSALS = new Set(['EPERM', 'EACCES', 'EROFS']);

/** The error's code when it's a refusal (`EPERM`, `EACCES`, `EROFS`). */
export function refusalCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && REFUSALS.has(code) ? code : undefined;
}

/**
 * A port on `127.0.0.1` refused to this process outright (`listen EPERM`;
 * `EACCES` on a port that needs no privilege): something around it keeps
 * it off local ports, so every port would be "taken".
 */
export class LocalPortsRefused extends Error {
  constructor(
    readonly port: number,
    readonly code: string,
  ) {
    super(`listen ${code} on 127.0.0.1:${port}`);
    this.name = 'LocalPortsRefused';
  }
}

/** The refusal's code when `err`, from listening on `port`, is one rather than a taken port. */
export function listenRefusal(err: unknown, port: number): string | undefined {
  const code = refusalCode(err);
  if (code === 'EPERM') return code;
  // Ports below 1024 need privileges on most systems: a refusal there is about the port.
  if (code === 'EACCES' && (port === 0 || port >= 1024)) return code;
  return undefined;
}

/** What `kindgi dev` says when it can't listen on `127.0.0.1` at all (`port` 0: any port). */
export function localPortsRefused(port: number, code: string): string {
  const which = port === 0 ? code : `port ${port}: ${code}`;
  return `kindgi dev isn't allowed to listen on 127.0.0.1 (${which}), so no local port would work.\n  ${ownTerminalFix('kindgi dev')}\n`;
}

/** What `kindgi dev` says when it can't write a file or folder it needs. */
export function writeRefused(err: unknown, code: string): string {
  const path = (err as NodeJS.ErrnoException).path;
  return `kindgi dev isn't allowed to write ${path ?? 'the pack folder'} (${code}).\n  ${ownTerminalFix('kindgi dev')} Otherwise, check that your user can write there.\n`;
}

/**
 * The system calls that write: a refusal of one is a read-only place.
 * `open` is a read's call too. It's here because, where `kindgi dev`
 * asks (the dev lock, the pack service's listen, the runtime's start),
 * every read handles its own refusal first, so an `open` that gets here
 * was a write's. A new caller that reads must do the same.
 */
const WRITES = new Set([
  'open',
  'mkdir',
  'write',
  'rename',
  'chmod',
  'copyfile',
  'unlink',
  'rmdir',
]);

/**
 * What `kindgi dev` says for an error that is the system refusing it a
 * port on `127.0.0.1` or a write (`refusalCode`); `undefined` for any
 * other, which the caller reports as before.
 */
export function refusedHere(err: unknown): string | undefined {
  const { syscall } = (err ?? {}) as NodeJS.ErrnoException;
  if (syscall === 'listen') {
    const port = (err as { port?: unknown }).port;
    const at = typeof port === 'number' ? port : 0;
    const code = listenRefusal(err, at);
    return code === undefined ? undefined : localPortsRefused(at, code);
  }
  const code = refusalCode(err);
  return code !== undefined && syscall !== undefined && WRITES.has(syscall)
    ? writeRefused(err, code)
    : undefined;
}
