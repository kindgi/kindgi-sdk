// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What the CLI says when something around it (a coding agent's sandbox,
 * often) stops `docker`, a port on `127.0.0.1` or a write: each refusal in
 * the system's own words, and the person's own terminal as the fix.
 */

import { describe, expect, test } from 'vitest';

import {
  dockerReach,
  dockerUnreachable,
  listenRefusal,
  localPortsRefused,
  refusalCode,
  refusedHere,
} from '../src/dev/blocked.js';
import type { DockerOutcome } from '../src/dev/runtime-container.js';

const failed = (stderr: string): DockerOutcome => ({ code: 1, stdout: '', stderr });
const unspawned = (stderr: string, errorCode?: string): DockerOutcome => ({
  code: null,
  stdout: '',
  stderr,
  ...(errorCode !== undefined && { errorCode }),
});

/** An error as Node gives it for a system call. */
function sysError(code: string, syscall: string, more: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall, ...more });
}

const OWN_TERMINAL =
  'If a coding agent runs this, its sandbox is likely what stops it: run `kindgi dev` in your own terminal instead.';

describe('dockerReach', () => {
  test.each([
    ['not on the PATH', unspawned('spawn docker ENOENT', 'ENOENT'), 'not-installed'],
    ['not allowed to start', unspawned('spawn docker EPERM', 'EPERM'), 'not-started'],
    [
      'not runnable, the code read from the message',
      unspawned('spawn docker EACCES'),
      'not-started',
    ],
    ['no code at all', unspawned('spawn failed'), 'not-installed'],
    [
      'a socket that refuses the user (Linux)',
      failed(
        'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/version": dial unix /var/run/docker.sock: connect: permission denied',
      ),
      'socket-denied',
    ],
    [
      'a connect the system refuses',
      failed(
        'Cannot connect to the Docker daemon at unix:///Users/acme/.docker/run/docker.sock. dial unix /Users/acme/.docker/run/docker.sock: connect: operation not permitted',
      ),
      'socket-denied',
    ],
    [
      'an engine that does not answer',
      failed(
        'Cannot connect to the Docker daemon at unix:///Users/acme/.docker/run/docker.sock. Is the docker daemon running?',
      ),
      'not-running',
    ],
    [
      'an engine that does not answer (newer Docker)',
      failed(
        'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory',
      ),
      'not-running',
    ],
    [
      'an answer that is an error of its own',
      failed(
        'Error response from daemon: client version 1.52 is too new. Maximum supported API version is 1.47',
      ),
      'failed',
    ],
  ] as const)('%s', (_label, outcome, reach) => {
    expect(dockerReach(outcome)).toBe(reach);
  });
});

describe('dockerUnreachable', () => {
  test('a docker that would not start names the system refusal, then the fix', () => {
    expect(dockerUnreachable(unspawned('spawn docker EPERM', 'EPERM'), 'kindgi dev')).toBe(
      `\`kindgi dev\` couldn't start \`docker\` (spawn docker EPERM).\n  ${OWN_TERMINAL} Otherwise, check that the \`docker\` on your PATH can run.`,
    );
  });

  test('the message and its fix name the command being run', () => {
    const [said, fix] =
      dockerUnreachable(failed('connect: permission denied'), 'kindgi doctor')?.split('\n') ?? [];
    expect(said).toBe("Docker's socket refused `kindgi doctor`: connect: permission denied");
    expect(fix).toBe(
      '  If a coding agent runs this, its sandbox is likely what stops it: run `kindgi doctor` in your own terminal instead. Otherwise, your user needs access to Docker (on Linux, the `docker` group, or rootless Docker).',
    );
  });

  test("Docker that isn't installed keeps its usual fix", () => {
    expect(dockerUnreachable(unspawned('spawn docker ENOENT', 'ENOENT'), 'kindgi dev')).toBe(
      "Docker isn't installed, or `docker` isn't on your PATH (spawn docker ENOENT).\n  kindgi dev runs the Kindgi runtime in Docker: install Docker Desktop (or a Docker engine on Linux), then run this again.",
    );
  });

  test("a failure of Docker's own is left to the caller", () => {
    expect(dockerUnreachable(failed('Error response from daemon: conflict'), 'kindgi dev')).toBe(
      undefined,
    );
  });
});

describe('the system refusing a port or a write', () => {
  test.each([
    ['EPERM', 4000, 'EPERM'],
    ['EACCES', 4000, 'EACCES'],
    ['EACCES', 0, 'EACCES'],
    // A port below 1024 needs privileges: that's about the port, not this process.
    ['EACCES', 80, undefined],
    ['EADDRINUSE', 4000, undefined],
  ] as const)('listen %s on port %i', (code, port, refusal) => {
    expect(listenRefusal(sysError(code, 'listen'), port)).toBe(refusal);
  });

  test('refusalCode: only a refusal', () => {
    expect(refusalCode(sysError('EROFS', 'mkdir'))).toBe('EROFS');
    expect(refusalCode(sysError('ENOENT', 'open'))).toBe(undefined);
    expect(refusalCode(undefined)).toBe(undefined);
    expect(refusalCode('EPERM')).toBe(undefined);
  });

  test('a listen refused: the port, the code, the fix', () => {
    expect(refusedHere(sysError('EPERM', 'listen', { port: 4000 }))).toBe(
      `kindgi dev isn't allowed to listen on 127.0.0.1 (port 4000: EPERM), so no local port would work.\n  ${OWN_TERMINAL}\n`,
    );
    // Any port (0): the code alone.
    expect(localPortsRefused(0, 'EPERM')).toMatch(
      /^kindgi dev isn't allowed to listen on 127\.0\.0\.1 \(EPERM\), so no local port would work\./,
    );
    expect(refusedHere(sysError('EADDRINUSE', 'listen', { port: 4000 }))).toBe(undefined);
  });

  test('a write refused: the path, the code, the fix', () => {
    expect(refusedHere(sysError('EROFS', 'mkdir', { path: '/work/acme-pack/.kindgi/dev' }))).toBe(
      `kindgi dev isn't allowed to write /work/acme-pack/.kindgi/dev (EROFS).\n  ${OWN_TERMINAL} Otherwise, check that your user can write there.\n`,
    );
    expect(
      refusedHere(sysError('EACCES', 'open', { path: '/work/acme-pack/.kindgi/dev/runtime.env' })),
    ).toMatch(
      /^kindgi dev isn't allowed to write \/work\/acme-pack\/\.kindgi\/dev\/runtime\.env \(EACCES\)\./,
    );
  });

  test("anything else is the caller's to report", () => {
    expect(refusedHere(sysError('ENOENT', 'open', { path: '/nope' }))).toBe(undefined);
    // A refusal with no system call (a plain error with a code) isn't one of these.
    expect(refusedHere(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(undefined);
    expect(refusedHere(sysError('EPERM', 'read'))).toBe(undefined);
    expect(refusedHere(new Error('fetch failed'))).toBe(undefined);
  });
});
