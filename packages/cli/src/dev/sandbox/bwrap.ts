// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack service's bubblewrap sandbox on Linux.
 *
 * The root is bound read-only; the home folder, `/tmp`, `/var/tmp` and
 * `/run` are replaced by empty tmpfs (keys, cloud credentials, the Docker
 * socket, agents' sockets, other tools' temp files all gone); the runtime
 * and the dependencies are bound back read-only, the app read-write.
 * bwrap can't match names, so the secrets inside the app are found at
 * every start and masked one by one (`.env*` and the like with
 * `/dev/null`, `.git` and other `.kindgi` folders with an empty tmpfs;
 * this app's `.kindgi` with a tmpfs and its dev outputs bound back). The
 * service keeps the host's network (an outbound call, its loopback
 * listener) and gets its own PID namespace, so it can't see other
 * processes (or read their environment).
 *
 * bwrap doesn't forward signals, and its PID-namespace init ignores
 * SIGTERM: a reload would never let the old service drain. So the service
 * runs as PID 1 (`--as-pid-1`, it has its own handlers), started through
 * a small `sh` wrapper ({@link BWRAP_WRAPPER}) that reads its PID from
 * `--info-fd` and forwards TERM and INT to it.
 */

import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  devBundleMapPath,
  devDistDir,
  devIndexPath,
  devJvmDir,
  devStagedIndexPath,
  devStagedPackIndexPath,
} from '../paths.js';
import type { SandboxPolicy } from './policy.js';

/** File names masked wherever they are in the app. */
const SECRET_FILE = /^(\.env.*|kindgi\.env|pack\.env|\.kindgirc\.json|\.npmrc|\.pypirc|\.netrc)$/;
/** Folders masked whole wherever they are in the app. */
const SECRET_DIR = /^(\.git|\.kindgi)$/;
/** Folders not searched: dependencies and build output hold no secret of the app's. */
const SKIPPED_DIR = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.next',
  '.turbo',
]);
/** How many entries the search looks at, at most. */
const MAX_ENTRIES = 100_000;

export interface AppSecrets {
  readonly files: readonly string[];
  readonly dirs: readonly string[];
  /** The search stopped at {@link MAX_ENTRIES}: secrets further down aren't masked. */
  readonly truncated: boolean;
}

/** The secret files and folders in the app, as they are now. Symlinks aren't followed. */
export async function appSecrets(app: string): Promise<AppSecrets> {
  const found = { files: [] as string[], dirs: [] as string[] };
  let seen = 0;
  const queue = [app];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await readdir(dir).catch(() => [] as string[]);
    seen += entries.length;
    if (seen > MAX_ENTRIES) return { ...found, truncated: true };
    for (const name of entries) {
      const next = await classify(join(dir, name), name, found);
      if (next !== undefined) queue.push(next);
    }
  }
  return { ...found, truncated: false };
}

/** Records a secret; returns a folder to search next. */
async function classify(
  path: string,
  name: string,
  found: { files: string[]; dirs: string[] },
): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink()) return undefined;
  if (!info.isDirectory()) {
    if (SECRET_FILE.test(name)) found.files.push(path);
    return undefined;
  }
  if (SECRET_DIR.test(name)) {
    found.dirs.push(path);
    return undefined;
  }
  return SKIPPED_DIR.has(name) ? undefined : path;
}

/** bwrap's arguments for the policy, before `--` and the command. */
export function bwrapArgs(policy: SandboxPolicy, secrets: AppSecrets): string[] {
  const { app, home } = policy;
  const args = ['--die-with-parent', '--unshare-pid', '--as-pid-1', '--unshare-ipc'];
  args.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc');
  args.push('--tmpfs', home, '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/run');
  // DNS on a systemd-resolved host: resolv.conf points into /run.
  const resolved = '/run/systemd/resolve';
  const sockets = policy.allowUnixSockets.filter((s) => existsSync(s));
  if (existsSync(resolved)) args.push('--ro-bind', resolved, resolved);
  for (const socket of sockets) args.push('--bind', socket, socket);
  for (const root of policy.readRoots) args.push('--ro-bind', root, root);
  args.push('--bind', app, app);
  for (const file of secrets.files) args.push('--ro-bind', '/dev/null', file);
  for (const dir of secrets.dirs) args.push('--tmpfs', dir);
  if (secrets.dirs.includes(join(app, '.kindgi'))) args.push(...devOutputBinds(app));
  args.push('--chdir', app, '--setenv', 'TMPDIR', '/tmp');
  return args;
}

/** The dev outputs the service runs, bound back over this app's masked `.kindgi`. */
function devOutputBinds(app: string): string[] {
  const outputs = [
    devDistDir(app),
    devJvmDir(app, 'java'),
    devJvmDir(app, 'scala'),
    devIndexPath(app),
    devStagedIndexPath(app),
    devStagedPackIndexPath(app),
    devBundleMapPath(app),
  ];
  return outputs.filter((p) => existsSync(p)).flatMap((p) => ['--ro-bind', p, p]);
}

/**
 * Runs bwrap with its arguments and forwards TERM and INT to the
 * sandboxed process (bwrap reports its PID on `--info-fd`).
 *
 *   sh kindgi-dev-sandbox <bwrap args…> -- <command…>
 */
export const BWRAP_WRAPPER = `#!/bin/sh
# kindgi-dev-sandbox: written by kindgi dev at every start. Do not edit.
# Runs the pack service in bwrap and forwards TERM and INT to it: bwrap
# doesn't, and a reload must let the old service drain.
set -u
info=$(mktemp "\${TMPDIR:-/tmp}/kindgi-dev-sandbox.XXXXXX")
bwrap --info-fd 3 "$@" 3>"$info" &
bw=$!
forward() {
  child=$(sed -n 's/.*"child-pid": *\\([0-9][0-9]*\\).*/\\1/p' "$info")
  if [ -n "$child" ]; then kill "-$1" "$child" 2>/dev/null; else kill "-$1" "$bw" 2>/dev/null; fi
}
trap 'forward TERM' TERM
trap 'forward INT' INT
status=0
while :; do
  wait "$bw"
  status=$?
  kill -0 "$bw" 2>/dev/null || break
done
rm -f "$info"
exit "$status"
`;
