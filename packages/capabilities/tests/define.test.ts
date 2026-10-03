// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { CAPABILITY_SCHEMA_URI, defineCapability, route } from '../src/index.js';
import type { Capability, ModelInfo, ProviderMetadata } from '../src/index.js';
import { fakeProvider } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('defineCapability — happy path', () => {
  test('accepts a minimal declaration with one feature need', () => {
    const c: Capability = { needs: [{ feature: 'structured-output' }] };
    const r = defineCapability(c);
    expect(r.kind).toBe('ok');
  });

  test('accepts every kind of Requirement', () => {
    const c: Capability = {
      needs: [
        { feature: 'tool-use' },
        { contextWindow: { op: '>=', value: 128000 } },
        { costPerCall: { op: '<=', usd: 0.01 } },
        { region: 'us-east5' },
        { p95LatencyMs: { op: '<', value: 5000 } },
        { providers: { allow: ['anthropic-claude', 'vertex-gemini'] } },
      ],
      prefer: [
        { feature: 'lower-cost', weight: 1 },
        { feature: 'higher-accuracy', weight: 2 },
      ],
      budget: { maxCostUsd: 0.1, maxTokens: 8000, maxDurationMs: 30000 },
    };
    const r = defineCapability(c);
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
    expect(r.kind).toBe('ok');
  });
});

describe('defineCapability — validation', () => {
  test('rejects empty needs list', () => {
    const r = defineCapability({ needs: [] });
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('invalid-capability');
  });

  test('rejects unknown feature name', () => {
    const bad = { needs: [{ feature: 'telepathy' }] } as unknown as Capability;
    const r = defineCapability(bad);
    expect(r.kind).toBe('err');
  });

  test('rejects invalid comparison op on contextWindow', () => {
    const bad = {
      needs: [{ contextWindow: { op: '!=', value: 1 } }],
    } as unknown as Capability;
    const r = defineCapability(bad);
    expect(r.kind).toBe('err');
  });

  test('rejects negative cost', () => {
    const bad = {
      needs: [{ costPerCall: { op: '<=', usd: -1 } }],
    } as unknown as Capability;
    const r = defineCapability(bad);
    expect(r.kind).toBe('err');
  });
});

describe('CAPABILITY_SCHEMA_URI', () => {
  test('exports the canonical $id', () => {
    expect(CAPABILITY_SCHEMA_URI).toBe('https://kindgi.com/schemas/v1/capability.schema.json');
  });
});

describe('schema drift', () => {
  test('bundled capability.schema.json matches @kindgi/specs/capability.schema.json', async () => {
    const bundled = await readFile(join(__dirname, '..', 'src', 'capability.schema.json'), 'utf-8');
    const canonical = await readFile(
      createRequire(import.meta.url).resolve('@kindgi/specs/capability.schema.json'),
      'utf-8',
    );
    expect(JSON.parse(bundled)).toEqual(JSON.parse(canonical));
  });
});

describe('defineCapability — `kind` and `models` (capability schema 1.1.0)', () => {
  const model = (name: string): ModelInfo => ({
    name,
    contextWindow: 8192,
    features: ['batch'],
    cost: { promptUsdPer1kTokens: 0.001, completionUsdPer1kTokens: 0.001 },
  });
  const provider = (id: string, over: Partial<ProviderMetadata> = {}): ProviderMetadata => ({
    id,
    region: 'us-east-1',
    models: [model(`${id}/model-v1`)],
    ...over,
  });

  test('accepts a `kind`, and the defined capability routes to a provider of that kind', () => {
    const r = defineCapability({ kind: 'embedding', needs: [{ feature: 'batch' }] });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));
    expect(r.value.kind).toBe('embedding');

    const decision = route({
      capability: r.value,
      providers: [
        fakeProvider(provider('llm-a')),
        fakeProvider(provider('embed-a', { capabilityKind: 'embedding' })),
      ],
    });
    if (decision.kind === 'err') throw new Error(JSON.stringify(decision.error));
    expect(decision.value.provider.metadata.id).toBe('embed-a');
  });

  test('accepts a `models` requirement, and the defined capability routes within it', () => {
    const r = defineCapability({ needs: [{ models: { allow: ['beta'], deny: ['gamma'] } }] });
    if (r.kind === 'err') throw new Error(JSON.stringify(r.error.issues));

    const decision = route({
      capability: r.value,
      providers: [
        fakeProvider(
          provider('multi', { models: [model('alpha'), model('beta'), model('gamma')] }),
        ),
      ],
    });
    if (decision.kind === 'err') throw new Error(JSON.stringify(decision.error));
    expect(decision.value.model.name).toBe('beta');
  });

  test('rejects an empty `kind` and an unknown key inside `models`', () => {
    expect(defineCapability({ kind: '', needs: [{ feature: 'batch' }] }).kind).toBe('err');
    const bad = { needs: [{ models: { only: ['beta'] } }] } as unknown as Capability;
    expect(defineCapability(bad).kind).toBe('err');
  });
});
