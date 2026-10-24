// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expectTypeOf, it } from 'vitest';

import type { Deployment, RegisterDeploymentInput } from '../../src/resources/deployments.js';

describe('deployments — the project a deploy goes into', () => {
  it('a deploy may name its project, and the record may carry it', () => {
    expectTypeOf<RegisterDeploymentInput>()
      .toHaveProperty('projectId')
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<Deployment>().toHaveProperty('projectId').toEqualTypeOf<string | undefined>();
  });
});
