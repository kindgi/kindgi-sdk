// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { type RunHandlerBinding, type TokenResolver, createApp } from '@kindgi/api';
import type { RunId, TenantId } from '@kindgi/types';

import { StubBindingError, createStubAppBindings, createStubBinding } from '../src/index.js';

const resolveToken: TokenResolver = async () => ({ tenantId: 't-1' as TenantId });
const runHandler = createStubBinding<RunHandlerBinding>('runHandler', {
  invokeAgent: true,
  invokeFlow: true,
  resumeRun: true,
});

describe('createStubAppBindings', () => {
  test('satisfies every required createApp binding — the app mounts and serves', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  test('a stubbed kernel method fails loudly, naming the sub-binding', () => {
    const { kernelBinding } = createStubAppBindings();
    expect(() => kernelBinding.run.getRun('t-1' as TenantId, 'r-1' as RunId)).toThrow(
      StubBindingError,
    );
    try {
      kernelBinding.run.getRun('t-1' as TenantId, 'r-1' as RunId);
    } catch (err) {
      expect((err as StubBindingError).binding).toBe('kernelBinding.run');
      expect((err as StubBindingError).method).toBe('getRun');
    }
  });

  test('optional kernel eventBus is absent, not stubbed', () => {
    expect('eventBus' in createStubAppBindings().kernelBinding).toBe(false);
  });

  test('each call returns fresh, independent stubs', () => {
    expect(createStubAppBindings().memoryBinding).not.toBe(createStubAppBindings().memoryBinding);
  });
});
