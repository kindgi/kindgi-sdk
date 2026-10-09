// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test, vi } from 'vitest';

import {
  type AdapterFactory,
  type AdapterFactoryEntry,
  type ModelProvider,
  type ProviderMetadata,
  createAdapterFactoryRegistry,
} from '../src/index.js';

function fakeFactory(metadataFn?: (m: ProviderMetadata) => ProviderMetadata): AdapterFactory {
  return ({ metadata }) =>
    ({
      metadata: metadataFn !== undefined ? metadataFn(metadata) : metadata,
      async invoke(input) {
        return {
          message: { role: 'assistant', content: 'fake' },
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 },
          costUsd: 0,
          durationMs: 0,
          provider: { id: metadata.id, model: input.model },
        };
      },
    }) satisfies ModelProvider;
}

function fakeEntry(over: Partial<AdapterFactoryEntry> = {}): AdapterFactoryEntry {
  return {
    adapterId: '@acme/adapter-fake',
    capabilityKind: 'llm-inference',
    factory: fakeFactory(),
    ...over,
  };
}

describe('createAdapterFactoryRegistry', () => {
  test('register + get roundtrip returns the same entry', () => {
    const registry = createAdapterFactoryRegistry();
    const entry = fakeEntry();
    registry.register(entry);
    expect(registry.get(entry.adapterId)).toBe(entry);
    expect(registry.has(entry.adapterId)).toBe(true);
  });

  test('get unknown adapter returns undefined', () => {
    const registry = createAdapterFactoryRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.has('nope')).toBe(false);
  });

  test('duplicate registration throws', () => {
    const registry = createAdapterFactoryRegistry();
    const entry = fakeEntry();
    registry.register(entry);
    expect(() => registry.register(entry)).toThrow(/already registered/);
  });

  test('duplicate registration under same adapterId (different factory) throws', () => {
    const registry = createAdapterFactoryRegistry();
    registry.register(fakeEntry({ adapterId: 'x' }));
    expect(() => registry.register(fakeEntry({ adapterId: 'x' }))).toThrow(/already registered/);
  });

  test('list returns all registered entries', () => {
    const registry = createAdapterFactoryRegistry();
    registry.register(fakeEntry({ adapterId: 'a' }));
    registry.register(fakeEntry({ adapterId: 'b', capabilityKind: 'embedding' }));
    const entries = registry.list();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.adapterId))).toEqual(new Set(['a', 'b']));
  });

  test('seed pre-populates entries via constructor', () => {
    const registry = createAdapterFactoryRegistry([
      fakeEntry({ adapterId: 'a' }),
      fakeEntry({ adapterId: 'b' }),
    ]);
    expect(registry.list()).toHaveLength(2);
    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(true);
  });

  test('seed with duplicates throws at construction time', () => {
    expect(() =>
      createAdapterFactoryRegistry([fakeEntry({ adapterId: 'x' }), fakeEntry({ adapterId: 'x' })]),
    ).toThrow(/already registered/);
  });

  test('factory receives metadata + optional resolveApiKey', () => {
    const registry = createAdapterFactoryRegistry();
    const observed = vi.fn();
    registry.register({
      adapterId: 'observe',
      capabilityKind: 'llm-inference',
      factory: (input) => {
        observed(input);
        return fakeFactory()(input);
      },
    });
    const metadata: ProviderMetadata = {
      id: 'p1',
      region: 'r1',
      models: [
        {
          name: 'm1',
          contextWindow: 100,
          features: [],
          cost: { promptUsdPer1kTokens: 0, completionUsdPer1kTokens: 0 },
        },
      ],
    };
    const resolveApiKey = async (): Promise<string> => 'sk-fake';

    const entry = registry.get('observe');
    entry?.factory({ metadata, resolveApiKey });
    expect(observed).toHaveBeenCalledWith({ metadata, resolveApiKey });
  });
});

describe("a registry made with the runtime's identities", () => {
  const metadata = { id: 'p', region: 'us-east-2', models: [] } as unknown as ProviderMetadata;
  const azure = { getToken: async () => ({ token: 't' }) };
  const aws = async () => ({ accessKeyId: 'a', secretAccessKey: 's' });

  test("each factory gets them, and each check learns which are there; an input's own win", () => {
    const factory = vi.fn(fakeFactory());
    const checkConfig = vi.fn(() => []);
    const registry = createAdapterFactoryRegistry([fakeEntry({ factory, checkConfig })], {
      identities: { aws },
    });
    const entry = registry.get('@acme/adapter-fake');
    entry?.factory({ metadata });
    expect(factory).toHaveBeenLastCalledWith({ metadata, identities: { aws } });
    entry?.checkConfig?.({ metadata, hasSecretRef: false });
    expect(checkConfig).toHaveBeenLastCalledWith({
      metadata,
      hasSecretRef: false,
      identities: { azure: false, aws: true },
    });

    entry?.factory({ metadata, identities: { azure } });
    expect(factory).toHaveBeenLastCalledWith({ metadata, identities: { azure } });
    entry?.checkConfig?.({ metadata, hasSecretRef: false, identities: { azure: true, aws: false } });
    expect(checkConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ identities: { azure: true, aws: false } }),
    );
  });

  test("without them, entries are as registered: an entry with no check gets none", () => {
    const entry = fakeEntry();
    expect(createAdapterFactoryRegistry([entry]).get(entry.adapterId)).toBe(entry);
    const bound = createAdapterFactoryRegistry([entry], { identities: { azure } }).get(entry.adapterId);
    expect(bound?.checkConfig).toBeUndefined();
  });
});
