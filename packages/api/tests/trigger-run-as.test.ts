// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Naming the service account a trigger's runs act as (`runAsServiceAccountId`
 * on register and take-over): `resolveTriggerOwner` turns the id into the
 * owner, after a reader-ordered existence check and the `act_as` gate.
 *
 * - No id: the owner is the caller, unchanged.
 * - A reader (tenant admin) learns why a name is refused — 404 (no such
 *   account), 409 (unregistered, or a project's own account), 403 (exists
 *   but not `act_as`-able).
 * - A non-reader gets one 403 for every reason, byte-identical, so they
 *   can't probe the tenant's accounts by naming ids.
 * - `runAsProject` names the project's own account: a project admin's to
 *   name, made last, after the request's other checks.
 */

import { randomUUID } from 'node:crypto';

import type { Context } from 'hono';
import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { resolveTriggerOwner } from '../src/routes/trigger-owners.js';
import type {
  ServiceAccount,
  ServiceAccountBinding,
  ServiceAccountProjectAccounts,
} from '../src/service-account-binding.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const ADA = randomUUID();
const BOT = randomUUID();
const PROJECT = randomUUID();

/** A minimal context: the gets `resolveTriggerOwner` reads, plus status/json. */
function ctx(actor?: { readonly kind: string; readonly id: string }): Context<AppEnv> {
  const store: Record<string, unknown> = {
    requestId: 'req-run-as',
    tenantId,
    ...(actor !== undefined && { principal: { actor } }),
    // `callerRef` reads the person from here.
    ...(actor?.kind === 'user' && { userId: actor.id }),
  };
  let status = 200;
  return {
    get: (key: string) => store[key],
    status: (code: number) => {
      status = code;
    },
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context<AppEnv>;
}

const account = (over: Partial<ServiceAccount> = {}): ServiceAccount => ({
  serviceAccountId: BOT,
  tenantId,
  name: 'acme-nightly-bot',
  grants: [],
  createdAt: '2026-01-01T00:00:00.000Z' as never,
  ...over,
});

/** A binding whose `get` returns `value` for any id. */
const binding = (value: ServiceAccount | null): Pick<ServiceAccountBinding, 'get'> => ({
  get: async () => value,
});

// `actAsDenied` is a boolean: `false` → allowed, `true` → refused.
const allow = async () => false;
const deny = async () => true;
// `isProjectAdmin`: `true` → an admin of the project.
const admin = async () => true;
const notAdmin = async () => false;

async function parse(res: Response): Promise<{ status: number; code?: string; text: string }> {
  const text = await res.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    // Not JSON (a test stub's response): the raw text stands.
  }
  return { status: res.status, ...(code !== undefined && { code }), text };
}

describe('resolveTriggerOwner: no id names the caller', () => {
  test('a user caller owns the trigger', async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      {},
      {
        serviceAccounts: binding(account()),
        canReadServiceAccounts: async () => true,
        actAsDenied: deny,
        isProjectAdmin: notAdmin,
      },
    );
    expect(r).toEqual({ kind: 'owner', owner: { kind: 'user', id: ADA } });
  });

  test('a service-account caller owns it', async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'service_account', id: BOT }),
      {},
      {
        serviceAccounts: undefined,
        canReadServiceAccounts: async () => false,
        actAsDenied: deny,
        isProjectAdmin: notAdmin,
      },
    );
    expect(r).toEqual({ kind: 'owner', owner: { kind: 'service', id: BOT } });
  });
});

describe('resolveTriggerOwner: act_as, both ways', () => {
  test('held: the named account becomes the owner (a service, not a user)', async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(account()),
        canReadServiceAccounts: async () => true,
        actAsDenied: allow,
        isProjectAdmin: notAdmin,
      },
    );
    expect(r).toEqual({ kind: 'owner', owner: { kind: 'service', id: BOT } });
  });

  test('not held, account readable: a 403, not the delegation', async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(account()),
        canReadServiceAccounts: async () => true,
        actAsDenied: deny,
        isProjectAdmin: notAdmin,
      },
    );
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') throw new Error('unreachable');
    const { status, code } = await parse(r.response);
    expect([status, code]).toEqual([403, 'permission-denied']);
  });
});

describe('resolveTriggerOwner: a reader learns why, by status', () => {
  test('no such account → 404', async () => {
    const r = await resolveTriggerOwner(
      ctx(),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(null),
        canReadServiceAccounts: async () => true,
        actAsDenied: allow,
        isProjectAdmin: notAdmin,
      },
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code } = await parse(r.response);
    expect([status, code]).toEqual([404, 'service-account-not-found']);
  });

  test('no binding at all → 404 (there is no such account)', async () => {
    const r = await resolveTriggerOwner(
      ctx(),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: undefined,
        canReadServiceAccounts: async () => true,
        actAsDenied: allow,
        isProjectAdmin: notAdmin,
      },
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    expect((await parse(r.response)).status).toBe(404);
  });

  test('unregistered account → 409', async () => {
    const r = await resolveTriggerOwner(
      ctx(),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(account({ unregisteredAt: '2026-02-02T00:00:00.000Z' as never })),
        canReadServiceAccounts: async () => true,
        actAsDenied: allow,
        isProjectAdmin: notAdmin,
      },
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code } = await parse(r.response);
    expect([status, code]).toEqual([409, 'service-account-unregistered']);
  });
});

describe('resolveTriggerOwner: a non-reader gets one 403, for every reason', () => {
  const nonReader = {
    canReadServiceAccounts: async () => false,
    actAsDenied: deny,
    isProjectAdmin: notAdmin,
  } as const;

  test('missing, unregistered and not-act_as-able all look the same', async () => {
    const missing = await resolveTriggerOwner(
      ctx(),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(null),
        ...nonReader,
      },
    );
    const unregistered = await resolveTriggerOwner(
      ctx(),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(account({ unregisteredAt: '2026-02-02T00:00:00.000Z' as never })),
        ...nonReader,
      },
    );
    const forbidden = await resolveTriggerOwner(
      ctx(),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(account()),
        ...nonReader,
      },
    );
    const projectOwn = await resolveTriggerOwner(
      ctx(),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(account({ projectId: PROJECT })),
        ...nonReader,
      },
    );
    for (const r of [missing, unregistered, forbidden, projectOwn]) {
      expect(r.kind).toBe('refused');
    }
    if (
      missing.kind !== 'refused' ||
      unregistered.kind !== 'refused' ||
      forbidden.kind !== 'refused' ||
      projectOwn.kind !== 'refused'
    )
      throw new Error('unreachable');
    const a = await parse(missing.response);
    const b = await parse(unregistered.response);
    const c = await parse(forbidden.response);
    const d = await parse(projectOwn.response);
    // Byte-identical: a non-reader can't tell these four apart.
    expect([a.status, a.code]).toEqual([403, 'permission-denied']);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
  });
});

describe("resolveTriggerOwner: a project's own account isn't named by id", () => {
  test('a reader gets the 409, pointing at runAsProject', async () => {
    const r = await resolveTriggerOwner(
      ctx(),
      { runAsServiceAccountId: BOT },
      {
        serviceAccounts: binding(account({ projectId: PROJECT })),
        canReadServiceAccounts: async () => true,
        actAsDenied: allow,
        isProjectAdmin: admin,
      },
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code, text } = await parse(r.response);
    expect([status, code]).toEqual([409, 'service-account-project-owned']);
    expect(text).toContain('`runAsProject`');
  });
});

describe('resolveTriggerOwner: runAsProject', () => {
  const PA = randomUUID();
  /** A `projectAccounts` stub that records each `ensure`, answering `answer`. */
  function projectAccounts(
    answer: Awaited<ReturnType<ServiceAccountProjectAccounts['ensure']>> = {
      kind: 'ok',
      value: account({ serviceAccountId: PA, name: `project-${PROJECT}`, projectId: PROJECT }),
    },
  ): ServiceAccountProjectAccounts & { readonly calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      get: async () => null,
      ensure: async (input) => {
        calls.push(input);
        return answer;
      },
    };
  }
  const deps = (over: Partial<Parameters<typeof resolveTriggerOwner>[2]> = {}) => ({
    serviceAccounts: binding(null),
    canReadServiceAccounts: async () => false,
    actAsDenied: deny,
    isProjectAdmin: admin,
    ...over,
  });

  test("a project admin: the owner is the project's account, made with the caller as `by`", async () => {
    const accounts = projectAccounts();
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsProject: true, projectId: PROJECT },
      deps({ projectAccounts: accounts }),
    );
    expect(r).toEqual({
      kind: 'owner',
      owner: { kind: 'service', id: PA },
      projectAccount: true,
    });
    expect(accounts.calls).toEqual([{ tenantId, projectId: PROJECT, by: `user:${ADA}` }]);
  });

  test("`runAsProject: false` is today's rule: the caller", async () => {
    const accounts = projectAccounts();
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsProject: false, projectId: PROJECT },
      deps({ projectAccounts: accounts }),
    );
    expect(r).toEqual({ kind: 'owner', owner: { kind: 'user', id: ADA } });
    expect(accounts.calls).toEqual([]);
  });

  test('with runAsServiceAccountId too: a 400, and nothing is made', async () => {
    const accounts = projectAccounts();
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsProject: true, runAsServiceAccountId: BOT, projectId: PROJECT },
      deps({ projectAccounts: accounts }),
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code, text } = await parse(r.response);
    expect([status, code]).toEqual([400, 'bad-input']);
    expect(text).toContain('Name one: `runAsProject` or `runAsServiceAccountId`.');
    expect(accounts.calls).toEqual([]);
  });

  test('a trigger with no project: a 400', async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsProject: true },
      deps({ projectAccounts: projectAccounts() }),
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code, text } = await parse(r.response);
    expect([status, code]).toEqual([400, 'bad-input']);
    expect(text).toContain("`runAsProject` needs the trigger's project.");
  });

  test('not an admin of the project: a 403, and nothing is made', async () => {
    const accounts = projectAccounts();
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsProject: true, projectId: PROJECT },
      deps({ projectAccounts: accounts, isProjectAdmin: notAdmin }),
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code, text } = await parse(r.response);
    expect([status, code]).toEqual([403, 'permission-denied']);
    expect(text).toContain('Running a trigger as the project takes a project admin.');
    expect(accounts.calls).toEqual([]);
  });

  test("a runtime that can't make one: a 501", async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsProject: true, projectId: PROJECT },
      deps(),
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code, text } = await parse(r.response);
    expect([status, code]).toEqual([501, 'trigger-operation-unsupported']);
    expect(text).toContain("This runtime can't make a project's own account.");
  });

  test("its name taken by someone's account: the 409 says who can clear it", async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsProject: true, projectId: PROJECT },
      deps({
        projectAccounts: projectAccounts({
          kind: 'err',
          error: { code: 'service-account-name-taken', message: 'taken' },
        }),
      }),
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code, text } = await parse(r.response);
    expect([status, code]).toEqual([409, 'service-account-name-taken']);
    expect(text).toContain(
      `An account named \`project-${PROJECT}\` is already registered. A tenant admin can unregister it.`,
    );
  });

  test('a project the tenant lacks: the 404 the binding answers', async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'user', id: ADA }),
      { runAsProject: true, projectId: PROJECT },
      deps({
        projectAccounts: projectAccounts({
          kind: 'err',
          error: { code: 'project-not-found', message: 'No such project' },
        }),
      }),
    );
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code } = await parse(r.response);
    expect([status, code]).toEqual([404, 'project-not-found']);
  });
});
