// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readdirSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { SPECS_SCHEMAS_DIR } from '@kindgi/specs';

import { loadSpecRegistry, versionOf } from '../src/index.js';

describe('@kindgi/specs integration', () => {
  test('every canonical schema loads, registers, and cross-refs resolve', async () => {
    const result = await loadSpecRegistry(SPECS_SCHEMAS_DIR);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const ids = result.value.ids();
      // Every schema file in the package registered.
      const files = readdirSync(SPECS_SCHEMAS_DIR).filter((f) => f.endsWith('.schema.json'));
      expect(ids.length).toBe(files.length);
      // Every $id follows the versioned URL convention.
      for (const id of ids) {
        expect(id).toMatch(/^https:\/\/kindgi\.com\/schemas\/v\d+\/[a-z][a-z0-9-]*\.schema\.json$/);
      }
    }
  });

  test('versionOf succeeds for every loaded schema', async () => {
    const setup = await loadSpecRegistry(SPECS_SCHEMAS_DIR);
    if (setup.kind === 'err') throw new Error('setup failed');
    for (const id of setup.value.ids()) {
      const schemaResult = setup.value.getSchema(id);
      if (schemaResult.kind === 'err') throw new Error(`getSchema failed for ${id}`);
      const versionResult = versionOf(schemaResult.value);
      expect(versionResult.kind, `versionOf failed for ${id}`).toBe('ok');
      if (versionResult.kind === 'ok') {
        expect(versionResult.value.major).toBeGreaterThanOrEqual(1);
        expect(versionResult.value.semver).toMatch(/^\d+\.\d+\.\d+/);
      }
    }
  });

  test('a minimal valid flow document validates against flow.schema.json', async () => {
    const setup = await loadSpecRegistry(SPECS_SCHEMAS_DIR);
    if (setup.kind === 'err') throw new Error('setup failed');
    const doc = {
      id: 'test.flow',
      version: '1.0.0',
      nodes: [{ id: 'n1', kind: 'tool', ref: 'test.tool' }],
      edges: [],
    };
    const result = setup.value.validate('https://kindgi.com/schemas/v1/flow.schema.json', doc);
    expect(result.kind).toBe('ok');
  });

  test('a flow missing required fields fails validation with a helpful error', async () => {
    const setup = await loadSpecRegistry(SPECS_SCHEMAS_DIR);
    if (setup.kind === 'err') throw new Error('setup failed');
    const doc = { name: 'missing id and nodes' };
    const result = setup.value.validate('https://kindgi.com/schemas/v1/flow.schema.json', doc);
    expect(result.kind).toBe('err');
    if (result.kind === 'err' && result.error.code === 'validation-error') {
      expect(result.error.errors.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected validation-error');
    }
  });

  test('loadSpecRegistry returns a load error for a nonexistent directory', async () => {
    const result = await loadSpecRegistry('/nonexistent/path/that/does/not/exist');
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('schema-load-error');
    }
  });
});

describe('@kindgi/specs contracts match the code', () => {
  const base = 'https://kindgi.com/schemas/v1';
  async function validate(name: string, doc: unknown): Promise<boolean> {
    const setup = await loadSpecRegistry(SPECS_SCHEMAS_DIR);
    if (setup.kind === 'err') throw new Error('setup failed');
    return setup.value.validate(`${base}/${name}.schema.json`, doc).kind === 'ok';
  }

  const agent = (tools: unknown): Record<string, unknown> => ({
    id: 'acme.support-agent',
    version: '1.0.0',
    name: 'Support agent',
    instructions: 'Answer support questions.',
    capabilities: [{ needs: [{ feature: 'tool-use' }] }],
    tools,
    retrieval: [],
    guardrails: [],
  });

  test('agent tools are { id, version } references (agent 1.1.0)', async () => {
    expect(await validate('agent', agent([{ id: 'acme.lookup-order', version: '^1.2.0' }]))).toBe(
      true,
    );
    expect(await validate('agent', agent([]))).toBe(true);
    // Bare-string ids — `defineAgent` rejects them too.
    expect(await validate('agent', agent(['acme.lookup-order']))).toBe(false);
    expect(await validate('agent', agent([{ id: 'acme.lookup-order' }]))).toBe(false);
    expect(await validate('agent', agent([{ id: '  ', version: '1.0.0' }]))).toBe(false);
    expect(await validate('agent', agent([{ id: 'acme.x', version: '1.0.0', pinned: true }]))).toBe(
      false,
    );
  });

  test('pack agent tools are the same { id, version } references (pack 1.1.0)', async () => {
    const pack = (tools: unknown): Record<string, unknown> => ({
      id: 'com.acme.support',
      version: '1.0.0',
      name: 'Acme support',
      manifestVersion: '1.0',
      agents: [
        {
          id: 'acme.support-agent',
          instructions: 'Answer support questions.',
          capabilities: { needs: [{ feature: 'tool-use' }] },
          tools,
        },
      ],
    });
    expect(await validate('pack', pack([{ id: 'acme.lookup-order', version: '~1.2.0' }]))).toBe(
      true,
    );
    expect(await validate('pack', pack(['acme.lookup-order']))).toBe(false);
    expect(await validate('pack', pack([{ id: 'acme.lookup-order' }]))).toBe(false);
  });

  test('capability accepts `kind` and a `models` requirement (capability 1.1.0)', async () => {
    expect(await validate('capability', { kind: 'embedding', needs: [{ feature: 'batch' }] })).toBe(
      true,
    );
    expect(
      await validate('capability', {
        needs: [{ models: { allow: ['model-a'], deny: ['model-b'] } }],
      }),
    ).toBe(true);
    expect(await validate('capability', { kind: '', needs: [{ feature: 'batch' }] })).toBe(false);
    expect(await validate('capability', { needs: [{ models: { only: ['model-a'] } }] })).toBe(
      false,
    );
  });

  test('flow has no top-level `triggers` (flow 1.9.0)', async () => {
    const flow = {
      id: 'acme.flow',
      version: '1.0.0',
      nodes: [{ id: 'n1', kind: 'tool', ref: 'acme.tool' }],
      edges: [],
    };
    expect(await validate('flow', flow)).toBe(true);
    expect(await validate('flow', { ...flow, triggers: [{ kind: 'manual' }] })).toBe(false);
  });

  test('guardrail requires `check` and accepts the runtime extensions (guardrail 1.1.0)', async () => {
    const guardrail = {
      id: 'acme.response-not-empty',
      kind: 'zero-llm',
      check: 'required-substring',
      action: { 'on-violation': 'halt' },
    };
    expect(await validate('guardrail', guardrail)).toBe(true);
    const { check: _check, ...withoutCheck } = guardrail;
    expect(await validate('guardrail', withoutCheck)).toBe(false);
    expect(
      await validate('guardrail', {
        ...guardrail,
        sandbox: 'strict',
        limits: { memMB: 256, cpuMs: 1000 },
        network: { kind: 'allowlist', hosts: ['api.example.com'] },
        needsSpec: { secrets: { API_KEY: { type: 'string' } } },
      }),
    ).toBe(true);
    expect(
      await validate('guardrail', { ...guardrail, action: { 'on-violation': 'retry', retry: {} } }),
    ).toBe(false);
    expect(
      await validate('guardrail', {
        ...guardrail,
        action: { 'on-violation': 'retry', retry: { maxAttempts: 2 } },
      }),
    ).toBe(true);
    // `kind` and `on-violation` are open, non-empty strings.
    expect(
      await validate('guardrail', {
        ...guardrail,
        kind: 'sandbox-code',
        action: { 'on-violation': 'hitl-review' },
      }),
    ).toBe(true);
    expect(await validate('guardrail', { ...guardrail, kind: '' })).toBe(false);
    expect(await validate('guardrail', { ...guardrail, action: { 'on-violation': '' } })).toBe(
      false,
    );
  });
});
