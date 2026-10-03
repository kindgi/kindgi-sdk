// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { createToolRegistry, defineTool } from '@kindgi/tools';
import type { AnyTool, ToolRegistry } from '@kindgi/tools';
import type { TenantId, ToolId } from '@kindgi/types';

import { defineAgent } from '../src/define.js';
import { resolveTurnTools } from '../src/handlers/resolve-tools.js';

function lookupTool(version: string): AnyTool {
  const r = defineTool({
    id: 'acme.lookup' as ToolId,
    description: `lookup ${version}`,
    version,
    input: { type: 'null' },
    output: { type: 'null' },
    handler: async () => null,
  });
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value;
}

/**
 * A multi-tenant registry: each tenant has its own tools, loaded after a
 * tenant-specific delay (tenant A slower than tenant B, so two
 * concurrent turns interleave).
 */
function multiTenantRegistry(): ToolRegistry {
  const perTenant = new Map<string, ToolRegistry>([
    ['tenant-a', createToolRegistry([lookupTool('1.0.0')])],
    ['tenant-b', createToolRegistry([lookupTool('1.1.0')])],
  ]);
  const delays = new Map([
    ['tenant-a', 20],
    ['tenant-b', 1],
  ]);
  const unscoped = createToolRegistry();
  return {
    ...unscoped,
    async forTenant(tenantId: TenantId) {
      await new Promise((r) => setTimeout(r, delays.get(tenantId as string) ?? 0));
      const registry = perTenant.get(tenantId as string);
      if (registry === undefined) throw new Error(`unknown tenant ${tenantId as string}`);
      return registry;
    },
  };
}

const agent = (() => {
  const r = defineAgent({
    id: 'acme.helper',
    version: '1.0.0',
    name: 'Helper',
    instructions: 'Help.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools: [{ id: 'acme.lookup', version: '^1.0.0' }],
    retrieval: [],
    guardrails: [],
  });
  if (r.kind === 'err') throw new Error('agent spec invalid');
  return r.value;
})();

describe('resolveTurnTools — tools come from the turn tenant registry', () => {
  test('concurrent turns of two tenants each resolve their own tenant tools', async () => {
    const registry = multiTenantRegistry();
    const turn = async (tenantId: string) =>
      resolveTurnTools(await registry.forTenant(tenantId as TenantId), agent);
    const [a, b] = await Promise.all([turn('tenant-a'), turn('tenant-b')]);
    expect(a.byName.get('acme.lookup')?.resolvedVersion).toBe('1.0.0');
    expect(b.byName.get('acme.lookup')?.resolvedVersion).toBe('1.1.0');
  });

  test('a single-tenant registry serves itself', async () => {
    const registry = createToolRegistry([lookupTool('1.2.0')]);
    expect(await registry.forTenant('any' as TenantId)).toBe(registry);
    const tools = resolveTurnTools(await registry.forTenant('any' as TenantId), agent);
    expect(tools.byName.get('acme.lookup')?.resolvedVersion).toBe('1.2.0');
  });
});
