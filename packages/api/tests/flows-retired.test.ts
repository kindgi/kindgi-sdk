// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A retired flow (every version unregistered) can be found and brought
 * back: `GET /v1/flows?includeRetired=true` lists it as its highest
 * version with `unregisteredAt`, and `GET /v1/flows/:id/versions` answers
 * for it (not 404), with its unregistered versions under
 * `?includeTombstoned=true`. Both are asked for: the defaults list active
 * flows and versions only. A never-registered id is still 404.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type {
  FlowListInput,
  FlowListVersionsInput,
  FlowRegistryBinding,
  FlowVersionRecord,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'flows-retired-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const RETIRED = 'acme.retired';
const at = '2026-10-01T00:00:00.000Z';
const version = (v: string): FlowVersionRecord =>
  ({
    id: RETIRED,
    version: v,
    nodes: [{ id: 'extract', kind: 'tool', ref: 'inline' }],
    edges: [
      { id: 'e0', from: '$start', to: 'extract' },
      { id: 'e1', from: 'extract', to: '$end' },
    ],
    unregisteredAt: at,
  }) as unknown as FlowVersionRecord;

/** A registry holding one retired flow, recording what each list was asked. */
function harness() {
  const lists: FlowListInput[] = [];
  const versionLists: FlowListVersionsInput[] = [];
  const flowRegistry = {
    list: async (input: FlowListInput) => {
      lists.push(input);
      return { data: input.includeRetired === true ? [version('1.1.0')] : [] };
    },
    get: async () => null,
    headExists: async ({ flowId }: { flowId: string }) => flowId === RETIRED,
    listVersions: async (input: FlowListVersionsInput) => {
      versionLists.push(input);
      return {
        data: input.includeTombstoned === true ? [version('1.1.0'), version('1.0.0')] : [],
      };
    },
  } as unknown as FlowRegistryBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    flowRegistry,
  });
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { get, lists, versionLists };
}

describe('a retired flow can be found', () => {
  test('the list leaves it out by default, and lists it with ?includeRetired=true', async () => {
    const h = harness();
    const plain = await h.get('/v1/flows');
    expect(plain.body.data).toEqual([]);
    expect(h.lists[0]?.includeRetired).toBeUndefined();

    const all = await h.get('/v1/flows?includeRetired=true');
    expect(all.status).toBe(200);
    expect(h.lists[1]?.includeRetired).toBe(true);
    expect(all.body.data).toEqual([
      expect.objectContaining({ id: RETIRED, version: '1.1.0', unregisteredAt: at }),
    ]);
    expect(validateAgainst('FlowCollectionPage', all.body)).toEqual([]);
  });

  test('anything but `true` is the default', async () => {
    const h = harness();
    await h.get('/v1/flows?includeRetired=1');
    expect(h.lists[0]?.includeRetired).toBeUndefined();
  });
});

describe("a retired flow's versions", () => {
  test('answer 200 (not 404), its unregistered versions with ?includeTombstoned=true', async () => {
    const h = harness();
    const active = await h.get(`/v1/flows/${RETIRED}/versions`);
    expect(active.status).toBe(200);
    expect(active.body.data).toEqual([]);
    expect(h.versionLists[0]?.includeTombstoned).toBeUndefined();

    const all = await h.get(`/v1/flows/${RETIRED}/versions?includeTombstoned=true`);
    expect(all.status).toBe(200);
    expect(h.versionLists[1]?.includeTombstoned).toBe(true);
    expect(
      all.body.data.map((v: { version: string; unregisteredAt?: string }) => [
        v.version,
        v.unregisteredAt,
      ]),
    ).toEqual([
      ['1.1.0', at],
      ['1.0.0', at],
    ]);
    expect(validateAgainst('FlowCollectionPage', all.body)).toEqual([]);
  });

  test('a never-registered id is still 404', async () => {
    const h = harness();
    const res = await h.get('/v1/flows/acme.never/versions?includeTombstoned=true');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('flow-not-found');
    expect(h.versionLists).toEqual([]);
  });
});
