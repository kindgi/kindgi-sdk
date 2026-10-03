// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, RunHandlerFailure, TokenResolver } from '../src/index.js';

/**
 * `POST /v1/runs` — a binding's `RunHandlerFailure` on the wire:
 * mapped status, and `details` as the wire error's `details`.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'runs-binding-errors-token';

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

function appFailingWith(failure: RunHandlerFailure) {
  const runHandler: RunHandlerBinding = {
    invokeAgent: async () => ({ kind: 'err', error: failure }),
    invokeFlow: async () => ({ kind: 'err', error: failure }),
    resumeRun: async () => ({ kind: 'err', error: failure }),
  };
  return createApp({ ...createStubAppBindings(), resolveToken, runHandler });
}

async function startRun(app: ReturnType<typeof appFailingWith>) {
  const res = await app.request('/v1/runs', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'support-bot', input: { userMessage: 'hi' } }),
  });
  return { status: res.status, body: (await res.json()) as { error: Record<string, unknown> } };
}

describe('POST /v1/runs — binding failures on the wire', () => {
  test('details become the wire error details (not nested)', async () => {
    const violations = [
      {
        guardrailId: 'no-pii',
        result: { passed: false, reason: 'Response contains an email' },
        action: 'halt',
        severity: 'error',
        at: '2026-09-30T00:00:00.000Z',
      },
    ];
    const { status, body } = await startRun(
      appFailingWith({
        code: 'guardrail-violation',
        message: "Turn blocked by guardrail 'no-pii': Response contains an email",
        details: { violations, evaluationErrors: [] },
      }),
    );
    expect(status).toBe(422);
    expect(body.error).toMatchObject({
      code: 'guardrail-violation',
      message: "Turn blocked by guardrail 'no-pii': Response contains an email",
      details: { violations, evaluationErrors: [] },
    });
    expect(body.error.details).not.toHaveProperty('details');
  });

  test('code and message come from the failure, never from details', async () => {
    const { body } = await startRun(
      appFailingWith({
        code: 'unresolved-tool',
        message: 'Tool lookup failed',
        details: { code: 'other', message: 'other', toolId: 'search' },
      }),
    );
    expect(body.error).toMatchObject({
      code: 'unresolved-tool',
      message: 'Tool lookup failed',
      details: { toolId: 'search' },
    });
  });

  test('no details → no wire details', async () => {
    const { status, body } = await startRun(
      appFailingWith({ code: 'agent-not-found', message: 'No agent support-bot' }),
    );
    expect(status).toBe(404);
    expect(body.error).not.toHaveProperty('details');
  });
});
