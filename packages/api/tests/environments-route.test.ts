// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The tenant's env names (`GET /v1/environments`):
 *
 * - the names the env and secret stores hold between them, each once, in
 *   byte order, paged by a cursor of the last name shown;
 * - each store asked for one more than a page, after the cursor, for the
 *   caller's tenant;
 * - for a tenant admin;
 * - 501 when a wired store can't list its names; not mounted with neither.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { EnvName, TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  EnvBinding,
  EnvNamesInput,
  RunHandlerBinding,
  SecretBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PEOPLE = ['admin', 'editor'] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((p) => [p, randomUUID() as UserId])) as Record<
  Person,
  UserId
>;
const resolveToken: TokenResolver = async (token) => {
  const who = PEOPLE.find((p) => token === `${p}-token`);
  return who === undefined ? null : { tenantId, userId: ids[who] };
};
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

/** The tenant's admin may do anything; an editor reads and writes, never `admin`. */
const allowed = (id: string, action: Action) =>
  id === ids.admin || (id === ids.editor && action !== 'admin');
const decision = (ok: boolean, action: Action, resource: ResourceRef): Decision => ({
  allowed: ok,
  reason: ok ? 'test: allowed' : 'test: denied',
  evidence: { action, relation: '', resource: `${resource.type}:${resource.id}`, actorSubject: '' },
});
const authzCheckBinding: AuthzCheckBinding = {
  check: async (principal, action, resource) =>
    decision(allowed(principal.actor.id, action), action, resource),
  checkBatch: async (principal, action, resources) =>
    resources.map((r) => decision(allowed(principal.actor.id, action), action, r)),
};

const notUsed = (): never => {
  throw new Error('not used');
};

/** A store's names as `listEnvNames` gives them: after `after`, sorted, at most `limit`. */
function namesOf(names: readonly string[], asked: EnvNamesInput[]) {
  return async (input: EnvNamesInput): Promise<readonly EnvName[]> => {
    asked.push(input);
    return [...names]
      .filter((n) => input.after === undefined || n > input.after)
      .sort()
      .slice(0, input.limit) as EnvName[];
  };
}

function envStore(names: readonly string[] | undefined, asked: EnvNamesInput[]): EnvBinding {
  return {
    list: notUsed,
    get: notUsed,
    resolve: notUsed,
    set: notUsed,
    delete: notUsed,
    ...(names !== undefined && { listEnvNames: namesOf(names, asked) }),
  };
}

function secretStore(names: readonly string[] | undefined, asked: EnvNamesInput[]): SecretBinding {
  return {
    list: notUsed,
    get: notUsed,
    resolve: notUsed,
    getVersion: notUsed,
    listVersions: notUsed,
    set: notUsed,
    rotate: notUsed,
    revoke: notUsed,
    ...(names !== undefined && { listEnvNames: namesOf(names, asked) }),
  };
}

interface Stores {
  /** Unset: no env store. `null`: one that can't list its names. */
  readonly env?: readonly string[] | null;
  readonly secrets?: readonly string[] | null;
  readonly authz?: boolean;
}

function makeApp(stores: Stores) {
  const envAsked: EnvNamesInput[] = [];
  const secretsAsked: EnvNamesInput[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    ...(stores.env !== undefined && { envBinding: envStore(stores.env ?? undefined, envAsked) }),
    ...(stores.secrets !== undefined && {
      secretsBinding: secretStore(stores.secrets ?? undefined, secretsAsked),
    }),
    ...(stores.authz !== false && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });
  const call = async (path: string, who: Person = 'admin') => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${who}-token` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, envAsked, secretsAsked };
}

const names = (body: Record<string, any>) =>
  (body.data as { envName: string }[]).map((e) => e.envName);

/** Every page, following `nextCursor` from the first; a list that never ends fails. */
async function walk(h: ReturnType<typeof makeApp>, limit: number) {
  const pages: string[][] = [];
  let cursor: string | undefined;
  while (pages.length < 20) {
    const q = `?limit=${limit}${cursor === undefined ? '' : `&cursor=${cursor}`}`;
    const r = await h.call(`/v1/environments${q}`);
    expect(r.status).toBe(200);
    pages.push(names(r.body));
    expect(r.body.hasMore).toBe(r.body.nextCursor !== undefined);
    if (r.body.hasMore !== true) return pages;
    cursor = r.body.nextCursor as string;
  }
  throw new Error(`still more after ${pages.length} pages`);
}

describe("the tenant's env names", () => {
  test('both stores, each name once, in byte order', async () => {
    const h = makeApp({
      env: ['staging', 'local', 'prod', 'ab'],
      secrets: ['prod', 'ci', 'prod-eu', 'a0', 'a-b'],
    });
    const r = await h.call('/v1/environments');
    expect(r.status).toBe(200);
    // Byte order: `-` before the digits, the digits before the letters.
    expect(names(r.body)).toEqual(['a-b', 'a0', 'ab', 'ci', 'local', 'prod', 'prod-eu', 'staging']);
    expect(r.body).toMatchObject({ hasMore: false });
    expect(r.body.nextCursor).toBeUndefined();
  });

  test('each store is asked for one more than the page, after the cursor, for the tenant', async () => {
    const h = makeApp({ env: ['dev', 'prod'], secrets: ['prod', 'qa'] });
    const first = await h.call('/v1/environments?limit=2');
    expect(names(first.body)).toEqual(['dev', 'prod']);
    await h.call(`/v1/environments?limit=2&cursor=${first.body.nextCursor}`);
    for (const asked of [h.envAsked, h.secretsAsked]) {
      expect(asked).toEqual([
        { tenantId, limit: 3 },
        { tenantId, limit: 3, after: 'prod' },
      ]);
    }
  });

  test('paged: every name once, across both stores, and the last page says so', async () => {
    const env = ['a', 'c', 'e', 'g', 'h'];
    const secrets = ['b', 'c', 'd', 'h', 'i'];
    for (const limit of [1, 2, 3, 8, 9]) {
      const pages = await walk(makeApp({ env, secrets }), limit);
      expect(pages.flat()).toEqual(['a', 'b', 'c', 'd', 'e', 'g', 'h', 'i']);
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(limit);
      expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
    }
  });

  test('a page as long as what is left has no next one', async () => {
    const h = makeApp({ env: ['a', 'b'], secrets: ['b', 'c'] });
    const r = await h.call('/v1/environments?limit=3');
    expect(names(r.body)).toEqual(['a', 'b', 'c']);
    expect(r.body.hasMore).toBe(false);
    expect(r.body.nextCursor).toBeUndefined();
  });

  test('one store wired: its names', async () => {
    expect(names((await makeApp({ env: ['prod'] }).call('/v1/environments')).body)).toEqual([
      'prod',
    ]);
    expect(names((await makeApp({ secrets: ['qa'] }).call('/v1/environments')).body)).toEqual([
      'qa',
    ]);
  });

  test("a cursor this list didn't give: 400, and no store is asked", async () => {
    const h = makeApp({ env: ['prod'], secrets: ['qa'] });
    const notAName = Buffer.from('../prod', 'utf8').toString('base64url');
    for (const cursor of [notAName, '!!!']) {
      const r = await h.call(`/v1/environments?cursor=${cursor}`);
      expect([r.status, r.body.error?.code]).toEqual([400, 'bad-input']);
    }
    expect([...h.envAsked, ...h.secretsAsked]).toEqual([]);
  });
});

describe('who reads them', () => {
  test("the tenant's admin; anyone else is refused, and no store is asked", async () => {
    const h = makeApp({ env: ['prod'], secrets: ['qa'] });
    const editor = await h.call('/v1/environments', 'editor');
    expect([editor.status, editor.body.error?.code]).toEqual([403, 'permission-denied']);
    expect([...h.envAsked, ...h.secretsAsked]).toEqual([]);
    expect((await h.call('/v1/environments', 'admin')).status).toBe(200);
  });

  test('without authorization: any caller, as every route there', async () => {
    const h = makeApp({ env: ['prod'], authz: false });
    expect((await h.call('/v1/environments', 'editor')).status).toBe(200);
  });
});

describe('a runtime that cannot say', () => {
  test('a wired store without listEnvNames: 501 naming it, never a list missing its names', async () => {
    for (const [stores, store] of [
      [{ env: ['prod'], secrets: null }, 'secret'],
      [{ env: null, secrets: ['qa'] }, 'env'],
    ] as const) {
      const h = makeApp(stores);
      const r = await h.call('/v1/environments');
      expect([r.status, r.body.error?.code]).toEqual([501, 'environments-unsupported']);
      expect(r.body.error?.message).toContain(`its ${store} store`);
      expect([...h.envAsked, ...h.secretsAsked]).toEqual([]);
    }
  });

  test('neither store wired: no such route', async () => {
    expect((await makeApp({}).call('/v1/environments')).status).toBe(404);
  });
});
