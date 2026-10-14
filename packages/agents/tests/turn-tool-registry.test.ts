// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The registry a turn resolves its tools on: its project's reach when the registry knows projects. */

import { createToolRegistry } from '@kindgi/tools';
import type { ToolRegistry } from '@kindgi/tools';
import type { OrgId, ProjectId, TenantId } from '@kindgi/types';
import { describe, expect, test } from 'vitest';

import type { TurnContext } from '../src/handlers/context.js';
import { turnToolRegistry } from '../src/handlers/turn-environment.js';

function turn(toolRegistry: ToolRegistry, orgId?: string): TurnContext {
  return {
    input: {
      tenantId: 't-1' as TenantId,
      projectId: 'project-1' as ProjectId,
      ...(orgId !== undefined && { orgId: orgId as OrgId }),
    },
    bindings: { toolRegistry },
  } as unknown as TurnContext;
}

describe('turnToolRegistry', () => {
  test("with forProject, the turn's project and org, never forTenant", async () => {
    const asked: unknown[] = [];
    const scoped = createToolRegistry();
    const registry: ToolRegistry = {
      ...createToolRegistry(),
      forTenant: async () => {
        throw new Error('forTenant must not be asked when forProject is there');
      },
      forProject: async (input) => {
        asked.push(input);
        return scoped;
      },
    };
    expect(await turnToolRegistry(turn(registry, 'org-1'))).toBe(scoped);
    expect(await turnToolRegistry(turn(registry))).toBe(scoped);
    expect(asked).toEqual([
      { tenantId: 't-1', projectId: 'project-1', orgId: 'org-1' },
      { tenantId: 't-1', projectId: 'project-1' },
    ]);
  });

  test("without it, the tenant's registry", async () => {
    const registry = createToolRegistry();
    expect(await turnToolRegistry(turn(registry))).toBe(
      await registry.forTenant('t-1' as TenantId),
    );
  });
});
