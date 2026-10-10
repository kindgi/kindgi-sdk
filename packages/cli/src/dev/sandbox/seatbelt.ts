// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack service's Seatbelt profile on macOS (`sandbox-exec -f`).
 * Seatbelt applies the last rule that matches, so the order is the
 * policy:
 *
 * 1. allow by default (processes, the network, the system);
 * 2. close the home folder and the shared temp folders (keys, cloud
 *    credentials, registry tokens, other projects, other tools' temp
 *    files), then open the service's own temp folder;
 * 3. open what it runs: the app (read and write), the runtime and the
 *    dependencies (read), and stat-only the folders above them (a
 *    runtime resolves real paths through them);
 * 4. close the secrets inside all of that again: `.env*`, `.kindgi`
 *    (but the dev outputs it runs), `.git`, `kindgi.env`, `pack.env`,
 *    `.kindgirc.json`, `.npmrc`, `.pypirc`, `.netrc`;
 * 5. no UNIX sockets (the Docker socket, ssh-agent, a database's) but
 *    DNS's (`mDNSResponder`) and `dev.sandbox.allowUnixSockets`.
 */

import { dirname, join, parse } from 'node:path';

import {
  devBundleMapPath,
  devDistDir,
  devIndexPath,
  devJvmDir,
  devStagedIndexPath,
  devStagedPackIndexPath,
} from '../paths.js';
import type { SandboxPolicy } from './policy.js';

/** A path as an SBPL string literal. */
function str(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Every folder above `path`, up to `/`. */
function ancestors(path: string): string[] {
  const found: string[] = [];
  let at = path;
  const root = parse(path).root;
  while (at !== root) {
    at = dirname(at);
    found.push(at);
  }
  return found;
}

export function seatbeltProfile(policy: SandboxPolicy): string {
  const { app, home, tmpDir } = policy;
  const roots = policy.readRoots;
  const statOnly = [
    ...new Set([
      ...[app, ...roots, tmpDir].flatMap(ancestors),
      join(app, '.kindgi'),
      join(app, '.kindgi', 'dev'),
    ]),
  ];
  const devOutputs = [
    `(subpath ${str(devDistDir(app))})`,
    `(subpath ${str(devJvmDir(app, 'java'))})`,
    `(subpath ${str(devJvmDir(app, 'scala'))})`,
    ...[
      devIndexPath(app),
      devStagedIndexPath(app),
      devStagedPackIndexPath(app),
      devBundleMapPath(app),
    ].map((p) => `(literal ${str(p)})`),
  ];
  const sockets = [
    '(path-literal "/private/var/run/mDNSResponder")',
    ...policy.allowUnixSockets.map((p) => `(path-literal ${str(p)})`),
  ];
  return [
    '; The pack service under `kindgi dev`: written by kindgi dev at every start. Do not edit.',
    '(version 1)',
    '(allow default)',
    '',
    '; Closed: the home folder and the shared temp folders.',
    `(deny file-read* file-write* (subpath ${str(home)}) (subpath "/private/var/folders") (subpath "/private/tmp"))`,
    "; Its own temp folder; the JVM's perf data; Darwin's per-user caches.",
    `(allow file-read* file-write* (subpath ${str(tmpDir)}))`,
    '(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/hsperfdata_"))',
    '(allow file-read* (regex #"^/private/var/folders/[^/]+/[^/]+/C/"))',
    '',
    '; Open: the folders above what it runs, to look up (not to list or read).',
    `(allow file-read-metadata ${statOnly.map((p) => `(literal ${str(p)})`).join(' ')})`,
    '; Open: the runtime and the dependencies (read), the app (read and write).',
    ...(roots.length > 0
      ? [`(allow file-read* ${roots.map((r) => `(subpath ${str(r)})`).join(' ')})`]
      : []),
    `(allow file-read* file-write* (subpath ${str(app)}))`,
    '',
    '; Closed again, wherever they are: secrets.',
    '(deny file-read* file-write*',
    '  (regex #"/\\.env[^/]*$")',
    '  (regex #"/(kindgi\\.env|pack\\.env|\\.kindgirc\\.json|\\.npmrc|\\.pypirc|\\.netrc)$")',
    '  (regex #"/\\.git(/|$)")',
    '  (regex #"/\\.kindgi(/|$)"))',
    '; but the dev outputs the service runs.',
    `(allow file-read* ${devOutputs.join(' ')})`,
    '',
    "; No UNIX sockets (the Docker socket, ssh-agent, a database's), but DNS's and the allowed ones.",
    '(deny network-outbound (remote unix-socket))',
    `(allow network-outbound ${sockets.map((s) => `(remote unix-socket ${s})`).join(' ')})`,
    '',
  ].join('\n');
}
