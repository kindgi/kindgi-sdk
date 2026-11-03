// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  type PackEnvNameRecord,
  packEnvHint,
  packEnvProblemLines,
  packEnvSecretSetCommand,
  packEnvSetCommand,
} from '../src/env/pack-env-hint.js';

const PROJECT = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';

describe('packEnvSetCommand', () => {
  test("a project's deployment: the project's scope, and the env", () => {
    expect(
      packEnvSetCommand({ envName: 'prod', projectId: PROJECT, hasProjectMapping: false }),
    ).toBe(`kindgi env set NAME <value> --scope=project:${PROJECT} --env=prod`);
  });

  test('a tenant-wide deployment: the tenant', () => {
    expect(packEnvSetCommand({ envName: 'prod', hasProjectMapping: false })).toBe(
      'kindgi env set NAME <value> --scope=tenant --env=prod',
    );
  });

  test('an environment that maps to its project: --env alone', () => {
    expect(
      packEnvSetCommand({ envName: 'staging', projectId: PROJECT, hasProjectMapping: true }),
    ).toBe('kindgi env set NAME <value> --env=staging');
  });
});

describe('packEnvSecretSetCommand', () => {
  test("a project's deployment: the project's scope, and the env; the value is asked for", () => {
    expect(packEnvSecretSetCommand({ envName: 'prod', projectId: PROJECT })).toBe(
      `kindgi secrets set NAME --scope=project:${PROJECT} --env=prod`,
    );
  });

  test('a tenant-wide deployment: the tenant', () => {
    expect(packEnvSecretSetCommand({ envName: 'prod' })).toBe(
      'kindgi secrets set NAME --scope=tenant --env=prod',
    );
  });
});

describe('packEnvHint', () => {
  const target = { envName: 'prod', projectId: PROJECT, hasProjectMapping: false } as const;

  test('one name', () => {
    expect(packEnvHint({ ...target, names: ['API_BASE'] })).toBe(
      `API_BASE isn't set for prod. Set it with \`kindgi env set NAME <value> --scope=project:${PROJECT} --env=prod\`.`,
    );
  });

  test('several names, listed in order', () => {
    expect(packEnvHint({ ...target, names: ['API_BASE', 'DB_URL', 'SHOP_URL'] })).toBe(
      `API_BASE, DB_URL and SHOP_URL aren't set for prod. Set each with \`kindgi env set NAME <value> --scope=project:${PROJECT} --env=prod\`.`,
    );
  });
});

describe('packEnvProblemLines', () => {
  const target = { envName: 'prod', hasProjectMapping: false } as const;
  const name = (n: string, extra: Partial<PackEnvNameRecord> = {}): PackEnvNameRecord => ({
    name: n,
    required: true,
    kind: 'env',
    scope: { kind: 'tenant' },
    missing: false,
    ...extra,
  });

  test('nothing in the way: no lines, an optional name set nowhere included', () => {
    expect(
      packEnvProblemLines(
        [
          name('API_BASE'),
          name('LOG_LEVEL', { required: false, kind: null, scope: null, missing: true }),
        ],
        target,
      ),
    ).toEqual([]);
  });

  test('a line per reason: missing, secret-only, then each name set both ways', () => {
    expect(
      packEnvProblemLines(
        [
          name('A', { kind: null, scope: null, missing: true, problem: 'missing' }),
          name('B', { kind: 'secret', problem: 'secret-not-yet' }),
          name('C', { kind: 'secret', problem: 'secret-not-yet' }),
          name('D', {
            scope: { kind: 'project', id: PROJECT },
            problem: 'ambiguous',
            secretScope: { kind: 'tenant' },
          }),
        ],
        target,
      ),
    ).toEqual([
      "A isn't set for prod. Set it with `kindgi env set NAME <value> --scope=tenant --env=prod`.",
      "B and C are set only as secrets, which this server keeps out of a pack service's environment: a tool reads them per call (`ctx.secrets`).",
      `D is set both as a secret (tenant) and as a plain value (project ${PROJECT}): remove one, so it's clear which the pack service gets.`,
    ]);
  });

  test('a name set to a cloud secret too: each way, and whose that one is to remove', () => {
    expect(
      packEnvProblemLines(
        [
          name('E', {
            problem: 'ambiguous',
            cloudSecretScope: { kind: 'tenant' },
          }),
          name('F', {
            kind: 'secret',
            scope: { kind: 'org', id: 'org-1' },
            problem: 'ambiguous',
            cloudSecretScope: { kind: 'project', id: PROJECT },
          }),
          name('G', {
            problem: 'ambiguous',
            secretScope: { kind: 'org', id: 'org-1' },
            cloudSecretScope: { kind: 'tenant' },
          }),
        ],
        target,
      ),
    ).toEqual([
      "E is set both as a plain value (tenant) and as a cloud secret (tenant): remove one, so it's clear which the pack service gets. A cloud secret is your operator's to remove.",
      `F is set both as a secret (org org-1) and as a cloud secret (project ${PROJECT}): remove one, so it's clear which the pack service gets. A cloud secret is your operator's to remove.`,
      "G is set 3 ways: as a secret (org org-1), as a plain value (tenant) and as a cloud secret (tenant): remove all but one, so it's clear which the pack service gets. A cloud secret is your operator's to remove.",
    ]);
  });

  test('a name set only to a cloud secret is set: no line', () => {
    expect(
      packEnvProblemLines([name('H', { kind: 'cloud-secret', scope: { kind: 'tenant' } })], target),
    ).toEqual([]);
  });

  test('a reason a later runtime names: said by its code', () => {
    expect(packEnvProblemLines([name('A', { problem: 'a-later-reason' })], target)).toEqual([
      "A can't be given to the pack service yet (a-later-reason).",
    ]);
  });
});
