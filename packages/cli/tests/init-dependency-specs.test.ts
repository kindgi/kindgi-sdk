// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { resolveCliPackage } from '../src/cli-package.js';
import {
  kindgiRequirement,
  resolveKindgiDependencySpecs,
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
    expect(r).toEqual({ kind: 'ok', specs: { source: 'published', sdk: '0.4.0', cli: '0.4.0' } });
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

describe("a Python pack's kindgi", () => {
  test("a published CLI writes kindgi within the CLI's minor (0.x) or major", () => {
    expect(kindgiRequirement('0.1.0')).toBe('kindgi>=0.1,<0.2');
    expect(kindgiRequirement('0.1.7')).toBe('kindgi>=0.1,<0.2');
    expect(kindgiRequirement('0.12.0-preview.3')).toBe('kindgi>=0.12,<0.13');
    expect(kindgiRequirement('1.4.2')).toBe('kindgi>=1.4,<2');
    expect(kindgiRequirement('latest')).toBeUndefined();
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
      cli: { root: '/app/node_modules/@kindgi/cli', version: 'dev', sdkDependency: 'dev' },
      realpath: identity,
    });
    expect(r.kind).toBe('error');
  });
});

describe('resolveCliPackage', () => {
  test('finds this checkout’s @kindgi/cli package.json', () => {
    const info = resolveCliPackage();
    expect(info?.root).toMatch(/packages\/cli$/);
    expect(info?.sdkDependency).toBe('workspace:*');
  });
});
