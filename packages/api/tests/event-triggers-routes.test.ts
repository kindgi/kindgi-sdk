// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/event-triggers` reads the event kind from `config.eventKind`.
 * (It read `config.config.eventKind`, so every registration was refused
 * with 400 "`config.eventKind` is required".)
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver, TriggerRegistryBinding } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'event-triggers-routes';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

function harness() {
  const registered: unknown[] = [];
  const triggers = {
    register: async (input: { flowId: string; flowVersion: string; config: unknown }) => {
      registered.push(input);
      return {
        kind: 'ok',
        value: {
          kind: 'event',
          triggerId: 't-1',
          tenantId,
          flowId: input.flowId,
          flowVersion: input.flowVersion,
          config: input.config,
          label: null,
          status: 'active',
          lastFiredAt: null,
          createdAt: '2026-10-08T08:00:00.000Z',
          updatedAt: '2026-10-08T08:00:00.000Z',
        },
      };
    },
  } as unknown as TriggerRegistryBinding;
  const app = createApp({
    ...createStubAppBindings(),
    triggerRegistry: triggers,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
  const register = (body: unknown) =>
    app.request('/v1/event-triggers', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { register, registered };
}

describe('POST /v1/event-triggers', () => {
  test('registers with the event kind from config.eventKind', async () => {
    const { register, registered } = harness();
    const res = await register({
      flowId: 'acme.flow',
      flowVersion: '1.0.0',
      config: { eventKind: 'acme.happened', input: { a: 1 } },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as { eventKind: string }).eventKind).toBe('acme.happened');
    expect(registered).toMatchObject([
      { flowId: 'acme.flow', config: { eventKind: 'acme.happened', input: { a: 1 } } },
    ]);
  });

  test('without one it is refused (400), naming the field', async () => {
    const { register, registered } = harness();
    const res = await register({ flowId: 'acme.flow', flowVersion: '1.0.0', config: {} });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('`config.eventKind` is required');
    expect(registered).toEqual([]);
  });
});
