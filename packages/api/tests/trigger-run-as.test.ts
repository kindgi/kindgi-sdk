// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Naming the service account a trigger's runs act as (`runAsServiceAccountId`
 * on register and take-over): `resolveTriggerOwner` turns the id into the
 * owner, after a reader-ordered existence check, the `act_as` gate and a
 * check that the account can run the trigger's target.
 *
 * - No id: the owner is the caller, unchanged.
 * - A reader (tenant admin) learns why a name is refused — 404 (no such
 *   account), 409 (unregistered), 403 (exists but not `act_as`-able).
 * - A non-reader gets one 403 for every reason, byte-identical, so they
 *   can't probe the tenant's accounts by naming ids.
 * - Past the gate, an account that can't run the target is a 409
 *   (`service-account-cannot-run-target`), naming the account.
 */

import { randomUUID } from 'node:crypto';

import type { Context } from 'hono';
import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { resolveTriggerOwner } from '../src/routes/trigger-owners.js';
import type { ServiceAccount, ServiceAccountBinding } from '../src/service-account-binding.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const ADA = randomUUID();
const BOT = randomUUID();

/** A minimal context: the gets `resolveTriggerOwner` reads, plus status/json. */
function ctx(actor?: { readonly kind: string; readonly id: string }): Context<AppEnv> {
  const store: Record<string, unknown> = {
    requestId: 'req-run-as',
    tenantId,
    ...(actor !== undefined && { principal: { actor } }),
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
// `cannotRun` likewise: `false` → the account can run the target.
const runs = async () => false;

const TARGET = { kind: 'agent', agentId: 'acme.agent' } as const;

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
    const r = await resolveTriggerOwner(ctx({ kind: 'user', id: ADA }), undefined, TARGET, {
      serviceAccounts: binding(account()),
      canReadServiceAccounts: async () => true,
      actAsDenied: deny,
      cannotRun: runs,
    });
    expect(r).toEqual({ kind: 'owner', owner: { kind: 'user', id: ADA } });
  });

  test('a service-account caller owns it', async () => {
    const r = await resolveTriggerOwner(
      ctx({ kind: 'service_account', id: BOT }),
      undefined,
      TARGET,
      {
        serviceAccounts: undefined,
        canReadServiceAccounts: async () => false,
        actAsDenied: deny,
        cannotRun: runs,
      },
    );
    expect(r).toEqual({ kind: 'owner', owner: { kind: 'service', id: BOT } });
  });
});

describe('resolveTriggerOwner: act_as, both ways', () => {
  test('held: the named account becomes the owner (a service, not a user)', async () => {
    const r = await resolveTriggerOwner(ctx({ kind: 'user', id: ADA }), BOT, TARGET, {
      serviceAccounts: binding(account()),
      canReadServiceAccounts: async () => true,
      actAsDenied: allow,
      cannotRun: runs,
    });
    expect(r).toEqual({ kind: 'owner', owner: { kind: 'service', id: BOT } });
  });

  test('not held, account readable: a 403, not the delegation', async () => {
    const r = await resolveTriggerOwner(ctx({ kind: 'user', id: ADA }), BOT, TARGET, {
      serviceAccounts: binding(account()),
      canReadServiceAccounts: async () => true,
      actAsDenied: deny,
      cannotRun: runs,
    });
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') throw new Error('unreachable');
    const { status, code } = await parse(r.response);
    expect([status, code]).toEqual([403, 'permission-denied']);
  });
});

describe('resolveTriggerOwner: a reader learns why, by status', () => {
  test('no such account → 404', async () => {
    const r = await resolveTriggerOwner(ctx(), BOT, TARGET, {
      serviceAccounts: binding(null),
      canReadServiceAccounts: async () => true,
      actAsDenied: allow,
      cannotRun: runs,
    });
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code } = await parse(r.response);
    expect([status, code]).toEqual([404, 'service-account-not-found']);
  });

  test('no binding at all → 404 (there is no such account)', async () => {
    const r = await resolveTriggerOwner(ctx(), BOT, TARGET, {
      serviceAccounts: undefined,
      canReadServiceAccounts: async () => true,
      actAsDenied: allow,
      cannotRun: runs,
    });
    if (r.kind !== 'refused') throw new Error('expected refusal');
    expect((await parse(r.response)).status).toBe(404);
  });

  test('unregistered account → 409', async () => {
    const r = await resolveTriggerOwner(ctx(), BOT, TARGET, {
      serviceAccounts: binding(account({ unregisteredAt: '2026-02-02T00:00:00.000Z' as never })),
      canReadServiceAccounts: async () => true,
      actAsDenied: allow,
      cannotRun: runs,
    });
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code } = await parse(r.response);
    expect([status, code]).toEqual([409, 'service-account-unregistered']);
  });
});

describe('resolveTriggerOwner: a non-reader gets one 403, for every reason', () => {
  // The account can't run the target either: the 403 still wins, so no 409 leaks.
  const nonReader = {
    canReadServiceAccounts: async () => false,
    actAsDenied: deny,
    cannotRun: async () => true,
  } as const;

  test('missing, unregistered and not-act_as-able all look the same', async () => {
    const missing = await resolveTriggerOwner(ctx(), BOT, TARGET, {
      serviceAccounts: binding(null),
      ...nonReader,
    });
    const unregistered = await resolveTriggerOwner(ctx(), BOT, TARGET, {
      serviceAccounts: binding(account({ unregisteredAt: '2026-02-02T00:00:00.000Z' as never })),
      ...nonReader,
    });
    const forbidden = await resolveTriggerOwner(ctx(), BOT, TARGET, {
      serviceAccounts: binding(account()),
      ...nonReader,
    });
    for (const r of [missing, unregistered, forbidden]) {
      expect(r.kind).toBe('refused');
    }
    if (
      missing.kind !== 'refused' ||
      unregistered.kind !== 'refused' ||
      forbidden.kind !== 'refused'
    )
      throw new Error('unreachable');
    const a = await parse(missing.response);
    const b = await parse(unregistered.response);
    const c = await parse(forbidden.response);
    // Byte-identical: a non-reader can't tell these three apart.
    expect([a.status, a.code]).toEqual([403, 'permission-denied']);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('resolveTriggerOwner: past the gate, the account must be able to run the target', () => {
  test("it can't: a 409 naming the account and the target, asked for that account and target", async () => {
    const asked: unknown[] = [];
    const r = await resolveTriggerOwner(ctx({ kind: 'user', id: ADA }), BOT, TARGET, {
      serviceAccounts: binding(account()),
      canReadServiceAccounts: async () => true,
      actAsDenied: allow,
      cannotRun: async (id, target) => {
        asked.push([id, target]);
        return true;
      },
    });
    if (r.kind !== 'refused') throw new Error('expected refusal');
    const { status, code, text } = await parse(r.response);
    expect([status, code]).toEqual([409, 'service-account-cannot-run-target']);
    expect(JSON.parse(text).error.message).toBe(
      'Service account "acme-nightly-bot" can\'t run agent "acme.agent", so the trigger can\'t run as it. Give the account the editor role on the target\'s project, or name another account.',
    );
    expect(asked).toEqual([[BOT, TARGET]]);
  });

  test('the gate refuses first: the account is never asked', async () => {
    let asked = false;
    const r = await resolveTriggerOwner(ctx({ kind: 'user', id: ADA }), BOT, TARGET, {
      serviceAccounts: binding(account()),
      canReadServiceAccounts: async () => true,
      actAsDenied: deny,
      cannotRun: async () => {
        asked = true;
        return true;
      },
    });
    if (r.kind !== 'refused') throw new Error('expected refusal');
    expect((await parse(r.response)).status).toBe(403);
    expect(asked).toBe(false);
  });

  test('no account named: the caller owns it, and nothing is asked', async () => {
    let asked = false;
    const r = await resolveTriggerOwner(ctx({ kind: 'user', id: ADA }), undefined, TARGET, {
      serviceAccounts: binding(account()),
      canReadServiceAccounts: async () => true,
      actAsDenied: allow,
      cannotRun: async () => {
        asked = true;
        return true;
      },
    });
    expect(r).toEqual({ kind: 'owner', owner: { kind: 'user', id: ADA } });
    expect(asked).toBe(false);
  });
});
