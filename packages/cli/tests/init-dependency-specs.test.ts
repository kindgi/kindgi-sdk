// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { resolveCliPackage } from '../src/cli-package.js';
import {
  kindgiRequirement,
  resolveKindgiDependencySpecs,
  resolveKindgiJavaSource,
  resolveKindgiPythonSource,
} from '../src/init/dependency-specs.js';

const identity = async (p: string): Promise<string> => p;
const workspaceAt =
  (root: string) =>
  async (p: string): Promise<boolean> =>
    p === `${root}/pnpm-workspace.yaml`;

const checkoutCli = {
  root: '/kindgi/packages/cli',
  version: '0.0.0',
  sdkDependency: 'workspace:*',
};

// A packed CLI copied outside any node_modules (a deploy folder, an unpacked
// tarball): its own dependencies sit in its node_modules, and no workspace is above.
const deployedCli = { root: '/opt/app/cli', version: '0.4.0', sdkDependency: '0.4.0' };
const deployedSdkRoot =
  '/opt/app/cli/node_modules/.pnpm/@kindgi+sdk@0.4.0/node_modules/@kindgi/sdk';
const noWorkspace = async (): Promise<boolean> => false;

describe('resolveKindgiDependencySpecs', () => {
  test('checkout → another project: link both packages from the checkout', async () => {
    const r = await resolveKindgiDependencySpecs({
      targetDir: '/work/acme-app',
      packageManager: 'pnpm',
      cli: checkoutCli,
      sdkRoot: '/kindgi-sdk/packages/sdk',
      realpath: identity,
      exists: workspaceAt('/kindgi'),
    });
    expect(r).toEqual({
      kind: 'ok',
      specs: {
        source: 'local-checkout',
        sdk: 'link:/kindgi-sdk/packages/sdk',
        cli: 'link:/kindgi/packages/cli',
        connections: 'link:/kindgi-sdk/packages/connections',
      },
    });
  });

  test('npm projects get file: (npm has no link:)', async () => {
    const r = await resolveKindgiDependencySpecs({
      targetDir: '/work/app',
      packageManager: 'npm',
      cli: checkoutCli,
      sdkRoot: '/kindgi/packages/sdk',
      realpath: identity,
      exists: workspaceAt('/kindgi'),
    });
    expect(r.kind === 'ok' && r.specs.cli).toBe('file:/kindgi/packages/cli');
  });

  test('checkout → a pack inside the same workspace: workspace:*', async () => {
    const r = await resolveKindgiDependencySpecs({
      targetDir: '/kindgi/packs/demo',
      packageManager: 'pnpm',
      cli: checkoutCli,
      sdkRoot: '/kindgi/packages/sdk',
      realpath: identity,
      exists: workspaceAt('/kindgi'),
    });
    expect(r.kind === 'ok' && r.specs).toEqual({
      source: 'workspace',
      sdk: 'workspace:*',
      cli: 'workspace:*',
      connections: 'workspace:*',
    });
  });

  test('--link-local links even inside the workspace', async () => {
    const r = await resolveKindgiDependencySpecs({
      targetDir: '/kindgi/packs/demo',
      packageManager: 'pnpm',
      forceLocal: true,
      cli: checkoutCli,
      sdkRoot: '/kindgi/packages/sdk',
      realpath: identity,
      exists: workspaceAt('/kindgi'),
    });
    expect(r.kind === 'ok' && r.specs.source).toBe('local-checkout');
  });

  test('published CLI: pin its own version and the SDK spec it depends on', async () => {
    const r = await resolveKindgiDependencySpecs({
      targetDir: '/work/app',
      packageManager: 'pnpm',
      cli: {
        root: '/work/app/node_modules/@kindgi/cli',
        version: '0.4.0',
        sdkDependency: '0.4.0',
      },
      realpath: identity,
    });
    // Every @kindgi/* package is released at one version: connections pins the CLI's.
    expect(r).toEqual({
      kind: 'ok',
      specs: { source: 'published', sdk: '0.4.0', cli: '0.4.0', connections: '0.4.0' },
    });
  });

  test('a published CLI still pointing at workspace:* is a publisher error', async () => {
    const r = await resolveKindgiDependencySpecs({
      targetDir: '/work/app',
      packageManager: 'pnpm',
      cli: { root: '/x/node_modules/@kindgi/cli', version: '0.4.0', sdkDependency: 'workspace:*' },
      realpath: identity,
    });
    expect(r.kind).toBe('error');
  });

  test('never returns `latest`', async () => {
    const r = await resolveKindgiDependencySpecs({
      targetDir: '/work/app',
      packageManager: 'pnpm',
      cli: checkoutCli,
      sdkRoot: '/kindgi/packages/sdk',
      realpath: identity,
      exists: workspaceAt('/kindgi'),
    });
    expect(JSON.stringify(r)).not.toContain('latest');
  });
});

describe("the CLI's own @kindgi/sdk spec, not its path, says published or checkout", () => {
  type Seams = Parameters<typeof resolveKindgiPythonSource>[0];
  const allThree = async (seams: Seams) => [
    await resolveKindgiDependencySpecs({ targetDir: '/work/app', packageManager: 'npm', ...seams }),
    await resolveKindgiPythonSource(seams),
    await resolveKindgiJavaSource(seams),
  ];

  test('a packed CLI outside node_modules is published, at its own version', async () => {
    const seams = {
      cli: deployedCli,
      sdkRoot: deployedSdkRoot,
      realpath: identity,
      exists: noWorkspace,
    };
    expect(await allThree(seams)).toEqual([
      {
        kind: 'ok',
        specs: { source: 'published', sdk: '0.4.0', cli: '0.4.0', connections: '0.4.0' },
      },
      { kind: 'published', requirement: 'kindgi>=0.4,<0.5' },
      { kind: 'published', version: '0.4.0' },
    ]);
  });

  test.each(['^0.4.0', '~0.4.0', '0.12.0-preview.3', '1.0.0-rc.1'])(
    '%s is a plain version: published',
    async (spec) => {
      const version = spec.replace(/^[\^~]/, '');
      const r = await resolveKindgiDependencySpecs({
        targetDir: '/work/app',
        packageManager: 'npm',
        cli: { root: '/opt/app/cli', version, sdkDependency: spec },
        sdkRoot: deployedSdkRoot,
        realpath: identity,
        exists: noWorkspace,
      });
      expect(r).toEqual({
        kind: 'ok',
        specs: { source: 'published', sdk: spec, cli: version, connections: version },
      });
    },
  );

  test('a plain version is published even inside a pnpm workspace', async () => {
    const r = await resolveKindgiDependencySpecs({
      targetDir: '/opt/packs/demo',
      packageManager: 'pnpm',
      cli: deployedCli,
      sdkRoot: deployedSdkRoot,
      realpath: identity,
      exists: workspaceAt('/opt'),
    });
    expect(r.kind === 'ok' && r.specs.source).toBe('published');
  });

  test('workspace:* with no workspace above is an error naming the cause', async () => {
    const seams = {
      cli: { ...deployedCli, sdkDependency: 'workspace:*' },
      sdkRoot: deployedSdkRoot,
      realpath: identity,
      exists: noWorkspace,
    };
    const error = {
      kind: 'error',
      message:
        'This @kindgi/cli (/opt/app/cli) lists @kindgi/sdk as "workspace:*" but isn\'t in a Kindgi checkout: no pnpm-workspace.yaml at or above it. A packed or deployed CLI needs its workspace: specs replaced by versions.',
    };
    expect(await allThree(seams)).toEqual([error, error, error]);
  });

  test('workspace:* under node_modules stays a publisher error, even inside a pnpm workspace', async () => {
    const results = await allThree({
      cli: {
        root: '/work/app/node_modules/@kindgi/cli',
        version: '0.4.0',
        sdkDependency: 'workspace:*',
      },
      realpath: identity,
      exists: workspaceAt('/work/app'),
    });
    expect(
      results.map((r) => r.kind === 'error' && r.message.includes('publisher misconfiguration')),
    ).toEqual([true, true, true]);
  });

  test.each([
    ['/opt/app/cli', 'link:../sdk'],
    ['/opt/app/cli', 'catalog:'],
    ['/opt/app/cli', 'npm:@kindgi/sdk@0.4.0'],
    ['/work/app/node_modules/@kindgi/cli', 'file:../sdk'],
    ['/work/app/node_modules/@kindgi/cli', 'git+https://example.com/sdk.git'],
    ['/work/app/node_modules/@kindgi/cli', 'latest'],
    ['/work/app/node_modules/@kindgi/cli', '*'],
    ['/opt/app/cli', undefined],
    ['/work/app/node_modules/@kindgi/cli', undefined],
  ])('%s listing @kindgi/sdk as %s is an error naming the spec', async (root, spec) => {
    const seams = {
      cli: { root, version: '0.4.0', sdkDependency: spec },
      sdkRoot: deployedSdkRoot,
      realpath: identity,
      exists: noWorkspace,
    };
    const error = {
      kind: 'error',
      message: `This @kindgi/cli (${root}) lists @kindgi/sdk as "${spec ?? '(missing)'}", not a published version. Install a released @kindgi/cli, or pack this one with pnpm so its dependencies are versions.`,
    };
    expect(await allThree(seams)).toEqual([error, error, error]);
  });
});

describe("a Python pack's kindgi", () => {
  test("a published CLI writes kindgi within the CLI's minor (0.x) or major", () => {
    expect(kindgiRequirement('0.1.0')).toBe('kindgi>=0.1,<0.2');
    expect(kindgiRequirement('0.1.7')).toBe('kindgi>=0.1,<0.2');
    expect(kindgiRequirement('0.12.0-preview.3')).toBe('kindgi>=0.12,<0.13');
    expect(kindgiRequirement('1.4.2')).toBe('kindgi>=1.4,<2');
    expect(kindgiRequirement('latest')).toBeUndefined();
    // A release candidate's floor is itself, so installers take the rc (and then the release).
    expect(kindgiRequirement('0.1.4-rc.0')).toBe('kindgi>=0.1.4rc0,<0.2');
    expect(kindgiRequirement('0.2.0-rc.11')).toBe('kindgi>=0.2.0rc11,<0.3');
    expect(kindgiRequirement('1.0.0-beta.2')).toBe('kindgi>=1.0.0b2,<2');
    expect(kindgiRequirement('1.1.0-alpha.0')).toBe('kindgi>=1.1.0a0,<2');
  });

  test("published: from PyPI with that range; from a checkout: the checkout's SDK", async () => {
    expect(
      await resolveKindgiPythonSource({
        cli: { root: '/app/node_modules/@kindgi/cli', version: '0.1.0', sdkDependency: '0.1.0' },
        realpath: identity,
      }),
    ).toEqual({ kind: 'published', requirement: 'kindgi>=0.1,<0.2' });
    expect(
      await resolveKindgiPythonSource({
        cli: checkoutCli,
        sdkRoot: '/kindgi/packages/sdk',
        realpath: identity,
        exists: async () => true,
      }),
    ).toEqual({ kind: 'local-checkout', path: '/kindgi/sdks/python' });
  });

  test('a published CLI with a malformed version is a broken install, not a bare `kindgi`', async () => {
    const r = await resolveKindgiPythonSource({
      cli: { root: '/app/node_modules/@kindgi/cli', version: 'dev', sdkDependency: '0.1.0' },
      realpath: identity,
    });
    expect(r).toEqual({
      kind: 'error',
      message: "This @kindgi/cli's version (dev) isn't major.minor.patch — broken install.",
    });
  });
});

describe('resolveCliPackage', () => {
  test('finds this checkout’s @kindgi/cli package.json', () => {
    const info = resolveCliPackage();
    expect(info?.root).toMatch(/packages\/cli$/);
    expect(info?.sdkDependency).toBe('workspace:*');
  });
});
