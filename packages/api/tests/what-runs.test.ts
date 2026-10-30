// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `whatRuns`: the pin that covers a scope, else Latest for its project (a
 * segment's is its project's; with no project, the agent's Latest over
 * every project). `null` when neither has a version.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ProjectId, Semver, TenantId } from '@kindgi/types';

import { type LatestBinding, type LiveResolution, whatRuns } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PROD = randomUUID() as ProjectId;
const agentId = 'acme.desk';

/** A pin that `resolve` answers (or none), and Latest that records each question. */
function releases(pinned: LiveResolution | null, latest: Semver | null) {
  const asked: unknown[] = [];
  return {
    asked,
    releases: {
      live: {
        resolve: async () => pinned,
        list: async () => [],
      },
      latest: {
        async latest(q) {
          asked.push(q);
          return latest === null ? null : { version: latest, deploymentId: 'dep-1' };
        },
        byProject: async () => [],
      } satisfies LatestBinding,
    },
  };
}

describe('whatRuns', () => {
  test('a pin that covers the scope wins, and Latest is not asked', async () => {
    const pin: LiveResolution = {
      version: '1.0.0' as Semver,
      scope: { kind: 'project', projectId: PROD },
    };
    const { releases: r, asked } = releases(pin, '2.0.0' as Semver);
    expect(await whatRuns(r, { tenantId, agentId, projectId: PROD })).toEqual({
      follows: 'pin',
      version: '1.0.0',
      liveScope: { kind: 'project', projectId: PROD },
    });
    expect(asked).toEqual([]);
  });

  test("no pin: Latest for the scope's project, a segment's included", async () => {
    const { releases: r, asked } = releases(null, '2.0.0' as Semver);
    const segments = [{ key: 'region', value: 'eu' }];
    expect(await whatRuns(r, { tenantId, agentId, projectId: PROD, segments })).toEqual({
      follows: 'latest',
      version: '2.0.0',
      deploymentId: 'dep-1',
    });
    expect(asked).toEqual([{ tenantId, agentId, projectId: PROD }]);
  });

  test('no project (a tenant scope): Latest over every project', async () => {
    const { releases: r, asked } = releases(null, '2.0.0' as Semver);
    await whatRuns(r, { tenantId, agentId });
    expect(asked).toEqual([{ tenantId, agentId }]);
  });

  test('no pin and no Latest: null', async () => {
    const { releases: r } = releases(null, null);
    expect(await whatRuns(r, { tenantId, agentId, projectId: PROD })).toBeNull();
  });
});
