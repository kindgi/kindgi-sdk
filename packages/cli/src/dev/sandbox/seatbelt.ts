// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The pack service's Seatbelt profile on macOS (`sandbox-exec -f`).
 * Seatbelt applies the last rule that matches, so the order is the
 * policy:
 *
 * 1. allow by default (processes, the network, the system), but no
 *    writes anywhere: a binary it replaced (`/opt/homebrew/bin/git`, an
 *    app in `/Applications`) would run unsandboxed later;
 * 2. close the home folder and the shared temp folders (keys, cloud
 *    credentials, registry tokens, other projects, other tools' temp
 *    files), then open the service's own temp folder and the `/dev`
 *    nodes a runtime writes;
 * 3. open what it runs: the app (read and write), the runtime and the
 *    dependencies (read), and stat-only the folders above them (a
 *    runtime resolves real paths through them);
 * 4. close the secrets inside all of that again: `.env*`, `.kindgi`
 *    (but the dev outputs it runs, and the indexer's output folder),
 *    `.git`, `kindgi.env`, `pack.env`, `.kindgirc.json`, `.npmrc`,
 *    `.pypirc`, `.netrc`; and keep the app's Kindgi configuration
 *    unwritable (`kindgi dev` loads it, and it says how wide this is);
 * 5. no UNIX sockets (the Docker socket, ssh-agent, a database's) but
 *    DNS's (`mDNSResponder`) and `dev.sandbox.allowUnixSockets`;
 * 6. no Apple Events, LaunchServices (`open -a Terminal <a file it
 *    wrote>` would run it outside) or the keychain.
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
      ...[app, ...roots, tmpDir, ...policy.links.map((l) => l.path)].flatMap(ancestors),
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
  const writable = policy.writable.map((d) => `(subpath ${str(d)})`);
  const readOnly = policy.readOnly.map((f) => `(literal ${str(f)})`);
  const sockets = [
    '(path-literal "/private/var/run/mDNSResponder")',
    ...policy.allowUnixSockets.map((p) => `(path-literal ${str(p)})`),
  ];
  return [
    '; The pack service under `kindgi dev`: written by kindgi dev at every start. Do not edit.',
    '(version 1)',
    '(allow default)',
    '; No writes anywhere but where opened below.',
    '(deny file-write*)',
    '',
    '; Closed: the home folder and the shared temp folders.',
    `(deny file-read* file-write* (subpath ${str(home)}) (subpath "/private/var/folders") (subpath "/private/tmp"))`,
    "; Its own temp folder; the JVM's perf data; Darwin's per-user caches.",
    `(allow file-read* file-write* (subpath ${str(tmpDir)}))`,
    '(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/hsperfdata_"))',
    '(allow file-read* (regex #"^/private/var/folders/[^/]+/[^/]+/C/"))',
    '; The /dev nodes a runtime writes.',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
    '',
    '; Open: the folders above what it runs, to look up (not to list or read).',
    `(allow file-read-metadata ${statOnly.map((p) => `(literal ${str(p)})`).join(' ')})`,
    '; Open: the runtime and the dependencies (read), the app (read and write).',
    ...(roots.length > 0
      ? [`(allow file-read* ${roots.map((r) => `(subpath ${str(r)})`).join(' ')})`]
      : []),
    `(allow file-read* file-write* (subpath ${str(app)}))`,
    ...(policy.links.length > 0
      ? [
          '; The links what it runs resolves through (a uv-managed Python), each link only.',
          `(allow file-read* ${policy.links.map((l) => `(literal ${str(l.path)})`).join(' ')})`,
        ]
      : []),
    '',
    '; Closed again, wherever they are: secrets.',
    '(deny file-read* file-write*',
    '  (regex #"/\\.env[^/]*$")',
    '  (regex #"/(kindgi\\.env|pack\\.env|\\.kindgirc\\.json|\\.npmrc|\\.pypirc|\\.netrc)$")',
    '  (regex #"/\\.git(/|$)")',
    '  (regex #"/\\.kindgi(/|$)"))',
    '; but the dev outputs the service runs.',
    `(allow file-read* ${devOutputs.join(' ')})`,
    ...(writable.length > 0
      ? [
          "; and the indexer's output folder.",
          `(allow file-read* file-write* ${writable.join(' ')})`,
        ]
      : []),
    "; Kindgi's configuration: kindgi dev loads it, and it says how wide this sandbox is.",
    `(deny file-write* ${readOnly.join(' ')})`,
    '',
    "; No UNIX sockets (the Docker socket, ssh-agent, a database's), but DNS's and the allowed ones.",
    '(deny network-outbound (remote unix-socket))',
    `(allow network-outbound ${sockets.map((s) => `(remote unix-socket ${s})`).join(' ')})`,
    '',
    '; No Apple Events, or LaunchServices (opening an app, a file with one).',
    '(deny appleevent-send)',
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name-regex #"^com\\.apple\\.lsd\\.") (global-name "com.apple.coreservices.appleevents"))',
    "; The keychain: securityd's file keychains, secd's (but trustd, which checks TLS certificates).",
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name-regex #"^com\\.apple\\.securityd\\.") (global-name-regex #"^com\\.apple\\.security\\."))',
    '',
  ].join('\n');
}
