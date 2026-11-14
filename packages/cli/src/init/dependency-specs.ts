// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The version specs `kindgi init` writes for `@kindgi/sdk` (dependency)
 * and `@kindgi/cli` (devDependency) — one answer for both init modes —
 * and for `@kindgi/connections`, which a template that uses an app's
 * tools depends on.
 * The CLI is project-local: a project runs the `kindgi` it pins, never a
 * global one.
 *
 * Three cases, decided by the `@kindgi/sdk` spec in the running CLI's own
 * package.json (`classifyCli`), not by where the CLI lives: a packed CLI
 * can be copied anywhere (a deploy folder, an unpacked tarball), and only
 * a checkout keeps `workspace:*`.
 *
 *   - **published** — the spec is a version (pnpm rewrites `workspace:*`
 *     when it packs the CLI). `@kindgi/cli` pins the running CLI's
 *     version; `@kindgi/sdk` uses that spec. `@kindgi/connections` pins
 *     the CLI's version too: every `@kindgi/*` package is released at one
 *     version.
 *   - **workspace** — a source checkout, and the target is inside the
 *     same pnpm workspace (`packs/foo`): `workspace:*` for both.
 *   - **local-checkout** — a source checkout, target elsewhere (an
 *     existing app, a pilot repo) or `--link-local`: symlink the
 *     packages from the checkout (`link:`, or `file:` for npm);
 *     `@kindgi/connections` is the SDK's sibling there.
 *
 * Any other spec is an error that names it, and so is a `workspace:` spec
 * that isn't in a checkout.
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
  readonly connections: string;
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

  const install = await classifyCli(cli, cliRoot, exists);
  if (install.kind === 'error') return install;
  if (install.kind === 'published') {
    return {
      kind: 'ok',
      specs: { source: 'published', sdk: install.sdk, cli: cli.version, connections: cli.version },
    };
  }

  const sdkRootRaw = input.sdkRoot ?? resolveSdkPackageRoot();
  if (sdkRootRaw === undefined) {
    return {
      kind: 'error',
      message: 'Cannot resolve @kindgi/sdk from the CLI checkout — run the checkout install first.',
    };
  }
  const sdkRoot = await realpath(sdkRootRaw);

  if (input.forceLocal !== true) {
    const target = await realpath(input.targetDir);
    if (isInside(target, install.workspace)) {
      return {
        kind: 'ok',
        specs: {
          source: 'workspace',
          sdk: 'workspace:*',
          cli: 'workspace:*',
          connections: 'workspace:*',
        },
      };
    }
  }

  const protocol = localLinkProtocol(input.packageManager);
  return {
    kind: 'ok',
    specs: {
      source: 'local-checkout',
      sdk: `${protocol}${sdkRoot}`,
      cli: `${protocol}${cliRoot}`,
      connections: `${protocol}${join(dirname(sdkRoot), 'connections')}`,
    },
  };
}

type CliInstall =
  | { readonly kind: 'published'; readonly sdk: string }
  | { readonly kind: 'checkout'; readonly workspace: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * A version as a packed CLI lists it: `MAJOR.MINOR.PATCH`, with any
 * pre-release, led by `^` or `~` or neither, as pnpm writes `workspace:*`,
 * `workspace:^` and `workspace:~`.
 */
const PLAIN_VERSION = /^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * What the running CLI is, by the `@kindgi/sdk` spec in its own
 * package.json, checked in this order:
 *
 *   1. `workspace:` under a `node_modules`: a bad publish, even inside an
 *      app that is itself a pnpm workspace.
 *   2. A version: published, wherever the CLI was copied.
 *   3. `workspace:` with a pnpm workspace at or above the CLI: a checkout.
 *   4. `workspace:` with none: a packed or deployed copy whose specs were
 *      never replaced.
 *   5. Anything else (`link:`, `file:`, `catalog:`, a URL, `latest`, none):
 *      nothing a project can pin.
 */
async function classifyCli(
  cli: CliPackageInfo,
  cliRoot: string,
  exists: (path: string) => Promise<boolean>,
): Promise<CliInstall> {
  const sdk = cli.sdkDependency;
  if (sdk?.startsWith('workspace:')) {
    if (cliRoot.split(sep).includes('node_modules')) {
      return {
        kind: 'error',
        message: `This @kindgi/cli (${cli.version}) lists @kindgi/sdk as "${sdk}", not a published version — publisher misconfiguration.`,
      };
    }
    const workspace = await findPnpmWorkspaceRoot(cliRoot, exists);
    if (workspace !== undefined) return { kind: 'checkout', workspace };
    return {
      kind: 'error',
      message: `This @kindgi/cli (${cliRoot}) lists @kindgi/sdk as "${sdk}" but isn't in a Kindgi checkout: no pnpm-workspace.yaml at or above it. A packed or deployed CLI needs its workspace: specs replaced by versions.`,
    };
  }
  if (sdk !== undefined && PLAIN_VERSION.test(sdk)) return { kind: 'published', sdk };
  return {
    kind: 'error',
    message: `This @kindgi/cli (${cliRoot}) lists @kindgi/sdk as "${sdk ?? '(missing)'}", not a published version. Install a released @kindgi/cli, or pack this one with pnpm so its dependencies are versions.`,
  };
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
 *
 * A release candidate's floor is its own version in PEP 440
 * (`kindgi>=0.1.4rc0,<0.2`): installers skip pre-releases unless the
 * requirement names one, so the rc is tried with its own Python SDK, and
 * the same requirement takes the release once it's out.
 */
export function kindgiRequirement(cliVersion: string): string | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?/.exec(cliVersion);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const ceiling = major === 0 ? `0.${minor + 1}` : `${major + 1}`;
  const pre = match[4] === undefined ? undefined : PEP440_PRE[match[4]];
  const floor =
    pre === undefined
      ? major === 0
        ? `0.${minor}`
        : `${major}.${minor}`
      : `${major}.${minor}.${match[3]}${pre}${match[5]}`;
  return `kindgi>=${floor},<${ceiling}`;
}

/** npm's pre-release names, as PEP 440 spells them (`scripts/sync-python-version.mjs`). */
const PEP440_PRE: Readonly<Record<string, string>> = { alpha: 'a', beta: 'b', rc: 'rc' };
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
  const install = await classifyCli(cli, await realpath(cli.root), exists);
  if (install.kind === 'error') return install;
  if (install.kind === 'published') {
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

/**
 * Where a Java or Scala pack gets `com.kindgi:kindgi-pack` (and
 * kindgi-pack-scala): from Maven Central at the CLI's version (`published`;
 * the Release workflow publishes them there before the CLI reaches npm), or —
 * from a Kindgi checkout — the checkout's `sdks/java` and `sdks/scala`, which
 * install them into the local Maven and Ivy repositories.
 */
export type KindgiJavaSource =
  | { readonly kind: 'published'; readonly version: string }
  | { readonly kind: 'local-checkout'; readonly path: string; readonly version: string }
  | { readonly kind: 'error'; readonly message: string };

/** What a Java or Scala pack's "preview" means, said wherever one is made. */
export const JVM_PREVIEW =
  'Java and Scala support is in preview: tested and supported, but the API may still change in a later release without the usual deprecation period.';

/**
 * The resolver an sbt build needs for kindgi-pack: none from Maven Central;
 * for a checkout's, the local Maven repository (`./mvnw install` puts it
 * there), before Maven Central: the checkout's version can be one already
 * released there, and that jar lacks what the checkout has added since.
 */
export function sbtLocalResolver(source: KindgiJavaSource): string | undefined {
  return source.kind === 'local-checkout'
    ? 'externalResolvers := Resolver.mavenLocal +: externalResolvers.value'
    : undefined;
}

export async function resolveKindgiJavaSource(
  input: Pick<ResolveDependencySpecsInput, 'cli' | 'sdkRoot' | 'realpath' | 'exists'> = {},
): Promise<KindgiJavaSource> {
  const realpath = input.realpath ?? fsRealpath;
  const exists = input.exists ?? pathExists;
  const cli = input.cli ?? resolveCliPackage();
  if (cli === undefined) {
    return {
      kind: 'error',
      message: 'Cannot locate the @kindgi/cli package.json — broken install.',
    };
  }
  const install = await classifyCli(cli, await realpath(cli.root), exists);
  if (install.kind === 'error') return install;
  if (install.kind === 'published') return { kind: 'published', version: cli.version };
  const sdkRootRaw = input.sdkRoot ?? resolveSdkPackageRoot();
  if (sdkRootRaw === undefined) {
    return {
      kind: 'error',
      message: 'Cannot resolve @kindgi/sdk from the CLI checkout — run the checkout install first.',
    };
  }
  const java = join(await realpath(sdkRootRaw), '..', '..', 'sdks', 'java');
  if (!(await exists(join(java, 'pom.xml')))) {
    return {
      kind: 'error',
      message: `No Java SDK at ${java} — the Kindgi checkout is incomplete.`,
    };
  }
  return { kind: 'local-checkout', path: java, version: cli.version };
}
