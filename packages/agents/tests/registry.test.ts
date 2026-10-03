// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { defineAgent } from '../src/define.js';
import { createAgentRegistry } from '../src/registry.js';
import type { AgentId } from '../src/types.js';

const baseCapabilities = [{ needs: [{ feature: 'structured-output' as const }] }];

function agentAt(id: string, version: string) {
  const r = defineAgent({
    id,
    version,
    name: id,
    instructions: 'do work',
    capabilities: baseCapabilities,
    tools: [],
    retrieval: [],
    guardrails: [],
  });
  if (r.kind === 'err') throw new Error(r.error.message);
  return r.value;
}

describe('AgentRegistry', () => {
  test('register + get by (id, version)', () => {
    const reg = createAgentRegistry();
    const a = agentAt('acme.foo', '1.0.0');
    const r = reg.register(a);
    expect(r.kind).toBe('ok');
    const got = reg.get('acme.foo' as AgentId, '1.0.0');
    expect(got.kind).toBe('ok');
    if (got.kind === 'ok') expect(got.value.name).toBe('acme.foo');
  });

  test('duplicate registration is refused', () => {
    const reg = createAgentRegistry();
    reg.register(agentAt('acme.foo', '1.0.0'));
    const r = reg.register(agentAt('acme.foo', '1.0.0'));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('agent-already-registered');
  });

  test('same id at different versions registers independently', () => {
    const reg = createAgentRegistry();
    expect(reg.register(agentAt('acme.foo', '1.0.0')).kind).toBe('ok');
    expect(reg.register(agentAt('acme.foo', '1.1.0')).kind).toBe('ok');
    expect(reg.register(agentAt('acme.foo', '2.0.0')).kind).toBe('ok');
    expect(reg.listVersions('acme.foo' as AgentId).map((a) => a.version)).toEqual([
      '1.0.0',
      '1.1.0',
      '2.0.0',
    ]);
  });

  test('get without version returns latest semver', () => {
    const reg = createAgentRegistry();
    reg.register(agentAt('acme.foo', '1.0.0'));
    reg.register(agentAt('acme.foo', '2.0.0'));
    reg.register(agentAt('acme.foo', '1.5.0'));
    const r = reg.get('acme.foo' as AgentId);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.version).toBe('2.0.0');
  });

  test('semver comparison treats pre-release as lower than untagged', () => {
    const reg = createAgentRegistry();
    reg.register(agentAt('acme.foo', '1.0.0-rc.1'));
    reg.register(agentAt('acme.foo', '1.0.0'));
    const r = reg.getLatest('acme.foo' as AgentId);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value.version).toBe('1.0.0');
  });

  test('get for unknown id fails with agent-not-found', () => {
    const reg = createAgentRegistry();
    const r = reg.get('nonexistent' as AgentId);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('agent-not-found');
  });

  test('unregister removes a specific version', () => {
    const reg = createAgentRegistry();
    reg.register(agentAt('acme.foo', '1.0.0'));
    reg.register(agentAt('acme.foo', '2.0.0'));
    const r = reg.unregister('acme.foo' as AgentId, '1.0.0');
    expect(r.kind).toBe('ok');
    expect(reg.listVersions('acme.foo' as AgentId).map((a) => a.version)).toEqual(['2.0.0']);
  });

  test('unregister for missing version fails', () => {
    const reg = createAgentRegistry();
    reg.register(agentAt('acme.foo', '1.0.0'));
    const r = reg.unregister('acme.foo' as AgentId, '9.9.9');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('agent-not-found');
  });

  test('seed populates the registry at construction', () => {
    const reg = createAgentRegistry([agentAt('acme.foo', '1.0.0'), agentAt('acme.bar', '2.0.0')]);
    expect(reg.list()).toHaveLength(2);
  });
});
