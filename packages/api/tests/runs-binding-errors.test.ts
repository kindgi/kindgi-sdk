// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

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

async function startRun(
  app: ReturnType<typeof appFailingWith>,
  body: Record<string, unknown> = { agent: 'support-bot', input: { userMessage: 'hi' } },
) {
  const res = await app.request('/v1/runs', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: (await res.json()) as { error: Record<string, unknown> },
  };
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

  test("a turn its tenant's budget refused: 429, the wait in Retry-After, as the API's own refusal by it", async () => {
    const { status, retryAfter, body } = await startRun(
      appFailingWith({
        code: 'rate-limit-exceeded',
        message: 'Templates rendered for this tenant took its budget',
        details: {
          limit: 'template-render-time',
          budgetMs: 5000,
          retryAfterMs: 11_200,
          runId: 'run-1',
        },
      }),
    );
    expect([status, retryAfter]).toEqual([429, '12']);
    expect(body.error).toMatchObject({
      code: 'rate-limit-exceeded',
      details: { limit: 'template-render-time', budgetMs: 5000, runId: 'run-1' },
    });
    expect(body.error.details).not.toHaveProperty('retryAfterMs');
  });

  test("another failure's retryAfterMs is only a detail: no Retry-After", async () => {
    const { retryAfter, body } = await startRun(
      appFailingWith({
        code: 'unresolved-tool',
        message: 'Tool lookup failed',
        details: { toolId: 'search', retryAfterMs: 1000 },
      }),
    );
    expect(retryAfter).toBeNull();
    expect(body.error).toMatchObject({ details: { toolId: 'search', retryAfterMs: 1000 } });
  });

  test('no details → no wire details', async () => {
    const { status, body } = await startRun(
      appFailingWith({ code: 'agent-not-found', message: 'No agent support-bot' }),
    );
    expect(status).toBe(404);
    expect(body.error).not.toHaveProperty('details');
  });

  // Where the runtime suspends projects, no run starts in a suspended one,
  // an agent's turn or a flow's run.
  test.each([
    ['an agent', { agent: 'support-bot', input: { userMessage: 'hi' } }],
    ['a flow', { flow: 'pack.flow', input: {} }],
  ])('a suspended project: %s run is 409 project-suspended', async (_, start) => {
    const { status, body } = await startRun(
      appFailingWith({
        code: 'project-suspended',
        message: 'The project is suspended: no run starts in it until it is restored',
      }),
      start,
    );
    expect(status).toBe(409);
    expect(body.error).toMatchObject({ code: 'project-suspended' });
  });
});
