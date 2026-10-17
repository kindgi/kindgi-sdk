// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `observeSecretWrites`: the binding it wraps, member for member, with each
 * write told to the listeners, whatever its outcome, and a listener's own
 * failure never the write's.
 */

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import {
  SECRET_BINDING_MEMBERS,
  type SecretBinding,
  type SecretWritten,
  observeSecretWrites,
} from '../src/secrets-binding.js';

const scope = { kind: 'tenant', tenantId: 'acme-tenant' as TenantId } as const;
const ref = { scope, envName: 'production', name: 'acme-key' } as never;

/** A binding with every member, each recording that it was called. */
function fullBinding(calls: string[], failWrites = false): SecretBinding {
  const member = (name: string) => async () => {
    calls.push(name);
    if (failWrites && SECRET_BINDING_MEMBERS[name as keyof SecretBinding] === 'write') {
      throw new Error('the store failed');
    }
    return { kind: 'ok' } as never;
  };
  const binding: Record<string, unknown> = {};
  for (const [name, how] of Object.entries(SECRET_BINDING_MEMBERS)) {
    binding[name] = how === 'flag' ? true : member(name);
  }
  return binding as unknown as SecretBinding;
}

describe('observeSecretWrites', () => {
  test('passes every member of the binding on: each read and write reaches it, the flag is kept', async () => {
    const calls: string[] = [];
    const { binding } = observeSecretWrites(fullBinding(calls));
    for (const [name, how] of Object.entries(SECRET_BINDING_MEMBERS)) {
      const value = (binding as unknown as Record<string, unknown>)[name];
      if (how === 'flag') {
        expect(value, name).toBe(true);
        continue;
      }
      expect(typeof value, name).toBe('function');
      await (value as (input: unknown) => Promise<unknown>)(ref);
      expect(calls.at(-1), name).toBe(name);
    }
  });

  test('tells each listener of each write, and of no read', async () => {
    const heard: SecretWritten[] = [];
    const { binding, writes } = observeSecretWrites(fullBinding([]));
    writes.subscribe((written) => heard.push(written));
    await binding.resolve(ref);
    await binding.get(ref);
    await binding.set(ref);
    await binding.rotate(ref);
    await binding.revoke(ref);
    expect(heard).toEqual([
      { scope, envName: 'production', name: 'acme-key' },
      { scope, envName: 'production', name: 'acme-key' },
      { scope, envName: 'production', name: 'acme-key' },
    ]);
  });

  test('a failed write is still told; a listener that throws fails neither the write nor the others', async () => {
    const heard: string[] = [];
    const { binding, writes } = observeSecretWrites(fullBinding([], true));
    writes.subscribe(() => {
      throw new Error('a listener of its own');
    });
    writes.subscribe((written) => heard.push(written.name));
    await expect(binding.set(ref)).rejects.toThrow('the store failed');
    expect(heard).toEqual(['acme-key']);
    const ok = observeSecretWrites(fullBinding([]));
    ok.writes.subscribe(() => {
      throw new Error('a listener of its own');
    });
    await expect(ok.binding.rotate(ref)).resolves.toEqual({ kind: 'ok' });
  });

  test('a listener that unsubscribes hears no more', async () => {
    const heard: string[] = [];
    const { binding, writes } = observeSecretWrites(fullBinding([]));
    const stop = writes.subscribe((written) => heard.push(written.name));
    await binding.set(ref);
    stop();
    await binding.set(ref);
    expect(heard).toEqual(['acme-key']);
  });
});
