// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The version specs `kindgi init` writes for `@kindgi/sdk` (dependency)
 * and `@kindgi/cli` (devDependency) — one answer for both init modes.
 * The CLI is project-local: a project runs the `kindgi` it pins, never a
 * global one.
 *
 * Three cases, decided by where the running CLI lives:
 *
 *   - **published** — the CLI sits under `node_modules`. `@kindgi/cli`
 *     pins the running CLI's version; `@kindgi/sdk` uses the spec the
 *     published CLI itself depends on (pnpm rewrites `workspace:*` at
 *     publish time).
 *   - **workspace** — a source checkout, and the target is inside the
 *     same pnpm workspace (`packs/foo`): `workspace:*` for both.
 *   - **local-checkout** — a source checkout, target elsewhere (an
 *     existing app, a pilot repo) or `--link-local`: symlink both
 *     packages from the checkout (`link:`, or `file:` for npm).
 *
 * Never `latest` — an unpinned spec resolves to whatever the registry
 * serves that day, and before publishing it resolves to nothing.
 */

import { realpath as fsRealpath, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { type CliPackageInfo, resolveCliPackage } from '../cli-package.js';
import { type PackageManager, localLinkProtocol } from '../package-manager.js';
import { resolveSdkPackageRoot } from '../sdk-package.js';

export type DependencySource = 'published' | 'workspace' | 'local-checkout';

export interface KindgiDependencySpecs {
  readonly source: DependencySource;
  readonly sdk: string;
  readonly cli: string;
}

export interface ResolveDependencySpecsInput {
  /** The project that will depend on Kindgi (must exist). */
  readonly targetDir: string;
  readonly packageManager: PackageManager;
  /** `--link-local`: link the checkout even when the target is inside its workspace. */
  readonly forceLocal?: boolean;
  /** Test seams. */
  readonly cli?: CliPackageInfo;
  readonly sdkRoot?: string;
  readonly realpath?: (path: string) => Promise<string>;
  readonly exists?: (path: string) => Promise<boolean>;
}

export type ResolveDependencySpecsResult =
  | { readonly kind: 'ok'; readonly specs: KindgiDependencySpecs }
  | { readonly kind: 'error'; readonly message: string };

export async function resolveKindgiDependencySpecs(
  input: ResolveDependencySpecsInput,
): Promise<ResolveDependencySpecsResult> {
  const realpath = input.realpath ?? fsRealpath;
  const exists = input.exists ?? pathExists;
  const cli = input.cli ?? resolveCliPackage();
  if (cli === undefined) {
    return {
      kind: 'error',
      message: 'Cannot locate the @kindgi/cli package.json — broken install.',
    };
  }
  const cliRoot = await realpath(cli.root);

  if (cliRoot.split(sep).includes('node_modules')) return publishedSpecs(cli);

  const sdkRootRaw = input.sdkRoot ?? resolveSdkPackageRoot();
  if (sdkRootRaw === undefined) {
    return {
      kind: 'error',
      message: 'Cannot resolve @kindgi/sdk from the CLI checkout — run the checkout install first.',
    };
  }
  const sdkRoot = await realpath(sdkRootRaw);

  if (input.forceLocal !== true) {
    const workspace = await findPnpmWorkspaceRoot(cliRoot, exists);
    const target = await realpath(input.targetDir);
    if (workspace !== undefined && isInside(target, workspace)) {
      return { kind: 'ok', specs: { source: 'workspace', sdk: 'workspace:*', cli: 'workspace:*' } };
    }
  }

  const protocol = localLinkProtocol(input.packageManager);
  return {
    kind: 'ok',
    specs: { source: 'local-checkout', sdk: `${protocol}${sdkRoot}`, cli: `${protocol}${cliRoot}` },
  };
}

function publishedSpecs(cli: CliPackageInfo): ResolveDependencySpecsResult {
  const sdk = cli.sdkDependency;
  if (sdk === undefined || sdk.startsWith('workspace:')) {
    return {
      kind: 'error',
      message: `This @kindgi/cli (${cli.version}) lists @kindgi/sdk as "${sdk ?? '(missing)'}", not a published version — publisher misconfiguration.`,
    };
  }
  return { kind: 'ok', specs: { source: 'published', sdk, cli: cli.version } };
}

async function findPnpmWorkspaceRoot(
  from: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  let dir = from;
  for (;;) {
    if (await exists(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a Python pack's `kindgi` comes from: PyPI for a published CLI,
 * within the CLI's own minor; for a CLI run from a Kindgi checkout, that
 * checkout's Python SDK (`<kindgi-sdk>/sdks/python`, beside the
 * `@kindgi/sdk` this CLI resolves), installed editable.
 */
export type KindgiPythonSource =
  | {
      readonly kind: 'published';
      /** The PEP 508 requirement to write, e.g. `kindgi>=0.1,<0.2`. */
      readonly requirement: string;
    }
  | { readonly kind: 'local-checkout'; readonly path: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The `kindgi` requirement a published CLI writes: the Python SDK within the
 * CLI's minor (`0.x`) or major (from `1.0`). The Python SDK's minors follow
 * the npm packages'; its patches needn't, so a CLI patch release with no
 * Python release still resolves.
 */
export function kindgiRequirement(cliVersion: string): string | undefined {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(cliVersion);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0
    ? `kindgi>=0.${minor},<0.${minor + 1}`
    : `kindgi>=${major}.${minor},<${major + 1}`;
}

/**
 * The `kindgi-cli` requirement the PyPI CLI writes into a Python pack's dev
 * group: the same range as `kindgi` (`kindgi-cli` ships with every npm
 * release, at its version).
 */
export function kindgiCliRequirement(cliVersion: string): string {
  return (kindgiRequirement(cliVersion) ?? 'kindgi').replace(/^kindgi/, 'kindgi-cli');
}

/** The requirement to write for `source`: the published range, or the bare name a uv source pins. */
export function kindgiRequirementFor(
  source: Exclude<KindgiPythonSource, { kind: 'error' }>,
): string {
  return source.kind === 'published' ? source.requirement : 'kindgi';
}

export async function resolveKindgiPythonSource(
  input: Pick<ResolveDependencySpecsInput, 'cli' | 'sdkRoot' | 'realpath' | 'exists'> = {},
): Promise<KindgiPythonSource> {
  const realpath = input.realpath ?? fsRealpath;
  const exists = input.exists ?? pathExists;
  const cli = input.cli ?? resolveCliPackage();
  if (cli === undefined) {
    return {
      kind: 'error',
      message: 'Cannot locate the @kindgi/cli package.json — broken install.',
    };
  }
  if ((await realpath(cli.root)).split(sep).includes('node_modules')) {
    const requirement = kindgiRequirement(cli.version);
    if (requirement === undefined) {
      return {
        kind: 'error',
        message: `This @kindgi/cli's version (${cli.version}) isn't major.minor.patch — broken install.`,
      };
    }
    return { kind: 'published', requirement };
  }
  const sdkRootRaw = input.sdkRoot ?? resolveSdkPackageRoot();
  if (sdkRootRaw === undefined) {
    return {
      kind: 'error',
      message: 'Cannot resolve @kindgi/sdk from the CLI checkout — run the checkout install first.',
    };
  }
  const python = join(await realpath(sdkRootRaw), '..', '..', 'sdks', 'python');
  if (!(await exists(join(python, 'pyproject.toml')))) {
    return {
      kind: 'error',
      message: `No Python SDK at ${python} — the Kindgi checkout is incomplete.`,
    };
  }
  return { kind: 'local-checkout', path: python };
}
