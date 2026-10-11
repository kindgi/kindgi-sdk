// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The agents, flows, policies and eval-suites `/versions` lists check a
 * cursor with their binding's optional `issuedCursor` before reading the
 * list: one the binding didn't issue answers `400 bad-input`, never the
 * first page again. A binding without `issuedCursor` pages as before.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { CreateAppInput, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'issued-cursor-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const notUsed = async () => ({
  kind: 'err' as const,
  error: { code: 'bad-input' as const, message: 'not used in this suite' },
});
const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};
const auth = { authorization: `Bearer ${TOKEN}` };
const ISSUED = 'issued-by-the-binding';

/** A registry with one id: it counts the version-list reads, and says which cursors it issued. */
function registry(issued: boolean | 'no-method') {
  const reads: unknown[] = [];
  const binding = {
    headExists: async () => true,
    listVersions: async (input: unknown) => {
      reads.push(input);
      return { data: [] };
    },
    ...(issued !== 'no-method' && {
      issuedCursor: (list: string, cursor: Cursor) =>
        list === 'versions' && (cursor as unknown as string) === ISSUED && issued,
    }),
  };
  return { binding, reads };
}

const LISTS: readonly {
  readonly name: string;
  readonly path: string;
  readonly mount: (binding: unknown) => Partial<CreateAppInput>;
}[] = [
  {
    name: 'agents',
    path: '/v1/agents/acme.drafting/versions',
    mount: (b) => ({ agentRegistry: b as never }),
  },
  {
    name: 'flows',
    path: '/v1/flows/acme.intake/versions',
    mount: (b) => ({ flowRegistry: b as never }),
  },
  {
    name: 'policies',
    path: '/v1/policies/acme.refunds/versions',
    mount: (b) => ({ policyRegistry: b as never }),
  },
  {
    name: 'eval suites',
    path: '/v1/eval-suites/acme.answers/versions',
    mount: (b) => ({ evalSuiteRegistry: b as never }),
  },
];

function appWith(mount: Partial<CreateAppInput>) {
  return createApp({ ...createStubAppBindings(), resolveToken, runHandler, ...mount });
}

describe.each(LISTS)('$name /versions: the binding says which cursors it issued', (list) => {
  test('a cursor it didn’t issue: 400 bad-input, before the list is read', async () => {
    const { binding, reads } = registry(true);
    const res = await appWith(list.mount(binding)).request(`${list.path}?cursor=made-up`, {
      headers: auth,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-input');
    expect(reads).toEqual([]);
  });

  test('a cursor it issued: the next page', async () => {
    const { binding, reads } = registry(true);
    const res = await appWith(list.mount(binding)).request(`${list.path}?cursor=${ISSUED}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(reads).toHaveLength(1);
    expect((reads[0] as { cursor?: string }).cursor).toBe(ISSUED);
  });

  test('a binding without issuedCursor: any cursor reaches the list, as before', async () => {
    const { binding, reads } = registry('no-method');
    const res = await appWith(list.mount(binding)).request(`${list.path}?cursor=made-up`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect((reads[0] as { cursor?: string }).cursor).toBe('made-up');
  });

  test('no cursor: the first page, issuedCursor not asked', async () => {
    const { binding, reads } = registry(false);
    const res = await appWith(list.mount(binding)).request(list.path, { headers: auth });
    expect(res.status).toBe(200);
    expect(reads).toHaveLength(1);
  });
});
