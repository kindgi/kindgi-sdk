// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/approvals?waitTokenId=`: the approvals a run's open waits
 * belong to (T272). The route hands the tokens to the binding.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  HitlBinding,
  ListApprovalsBindingInput,
  ReviewerBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const resolveToken: TokenResolver = async (token) =>
  token === 'reviewer' ? { tenantId, reviewerRole: 'admin' } : null;

function app() {
  const inputs: ListApprovalsBindingInput[] = [];
  const hitlBinding = {
    listApprovals: async (input: ListApprovalsBindingInput) => {
      inputs.push(input);
      return { kind: 'ok', value: { approvals: [] } };
    },
  } as unknown as HitlBinding;
  const created = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => null } as ReviewerBinding,
    hitlBinding,
  });
  const list = (query: string) =>
    created.request(`/v1/approvals${query}`, { headers: { authorization: 'Bearer reviewer' } });
  return { list, inputs };
}

describe('GET /v1/approvals?waitTokenId=', () => {
  test('each value reaches the binding, in order; without one, no filter', async () => {
    const { list, inputs } = app();
    expect((await list('?waitTokenId=tok-a&waitTokenId=tok-b')).status).toBe(200);
    expect((await list('')).status).toBe(200);
    expect(inputs[0]?.waitTokenIds).toEqual(['tok-a', 'tok-b']);
    expect(inputs[1]).not.toHaveProperty('waitTokenIds');
  });

  test('more than 50 values, or an empty one, is 400 bad-input', async () => {
    const { list, inputs } = app();
    const many = Array.from({ length: 51 }, (_, i) => `waitTokenId=t${i}`).join('&');
    for (const query of [`?${many}`, '?waitTokenId=']) {
      const res = await list(query);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('bad-input');
      expect(body.error.message).toContain('`waitTokenId` takes at most 50 values');
    }
    expect(inputs).toEqual([]);
  });
});
