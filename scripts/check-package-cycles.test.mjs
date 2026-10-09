// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findCycles, localPackages } from './check-package-cycles.mjs';

const workspace = (manifests) =>
  new Map(Object.entries(manifests).map(([name, deps]) => [name, { name, ...deps }]));

test('packages that only depend downstream have no cycle', () => {
  const packages = workspace({
    '@acme/a': { dependencies: { '@acme/b': 'workspace:*', 'left-pad': '^1.0.0' } },
    '@acme/b': { dependencies: { '@acme/c': 'workspace:*' } },
    '@acme/c': {},
  });
  assert.deepEqual(findCycles(packages), []);
});

test("a test-only devDependency makes a cycle, printed as a path with each edge's kind", () => {
  const packages = workspace({
    '@acme/registry': { dependencies: { '@acme/authz': 'workspace:*' } },
    '@acme/authz': { devDependencies: { '@acme/registry': 'workspace:*' } },
    '@acme/other': { dependencies: { '@acme/authz': 'workspace:*' } },
  });
  assert.deepEqual(findCycles(packages), [
    {
      path: ['@acme/authz', '@acme/registry', '@acme/authz'],
      kinds: ['devDependencies', 'dependencies'],
    },
  ]);
});

test('one cycle per tangle, the shortest way round from its first name; separate tangles each', () => {
  const packages = workspace({
    '@acme/a': { dependencies: { '@acme/b': 'workspace:*' } },
    '@acme/b': { peerDependencies: { '@acme/c': 'workspace:*' } },
    '@acme/c': {
      optionalDependencies: { '@acme/a': 'workspace:*' },
      dependencies: { '@acme/b': 'workspace:*' },
    },
    '@acme/x': { dependencies: { '@acme/y': 'workspace:*' } },
    '@acme/y': { devDependencies: { '@acme/x': 'workspace:*' } },
  });
  assert.deepEqual(findCycles(packages), [
    {
      path: ['@acme/a', '@acme/b', '@acme/c', '@acme/a'],
      kinds: ['dependencies', 'peerDependencies', 'optionalDependencies'],
    },
    { path: ['@acme/x', '@acme/y', '@acme/x'], kinds: ['dependencies', 'devDependencies'] },
  ]);
});

test('a package naming itself, or a name outside the workspace, is no cycle', () => {
  const packages = workspace({
    '@acme/a': { devDependencies: { '@acme/a': 'workspace:*', '@acme/elsewhere': '^1.0.0' } },
  });
  assert.deepEqual(findCycles(packages), []);
});

test("this repository's packages: the globs and the plain site entry, and no cycle among them", () => {
  const packages = localPackages();
  const names = [...packages.keys()];
  for (const name of [
    '@kindgi/api',
    '@kindgi/testing',
    '@kindgi/cli',
    '@kindgi/adapter-model-anthropic',
  ]) {
    assert.ok(names.includes(name), `${name} is found`);
  }
  assert.ok(names.includes('kindgi-docs'), 'the site (the plain `site` entry) is found');
  assert.deepEqual(findCycles(packages), []);
});
