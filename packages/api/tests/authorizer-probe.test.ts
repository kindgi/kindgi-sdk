// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `Authorizer.probe` answers what `can` answers, and records nothing: the
 * API key's own limits first (unrecorded), then the binding's `probe`, else
 * its `check`. Only what a response shows the caller about its own access
 * reads through it (`canForDisplay`, `isTenantAdminForDisplay`); the last
 * test lists every such read, so a new one is a choice someone made.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Context, Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import {
  type Action,
  type AuthzCheckBinding,
  type Decision,
  type ResourceRef,
  ref,
  userPrincipal,
} from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import type { TenantId, UserId } from '@kindgi/types';

import { canForDisplay } from '../src/caller.js';
import { type Authorizer, createAuthorizer } from '../src/middleware/authorize.js';
import type { AppEnv } from '../src/types.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const projectA = '00000000-0000-4000-8000-00000000000a';
const projectB = '00000000-0000-4000-8000-00000000000b';

/** A caller as the request carries it: an API key's (or a session's) limits. */
interface Limits {
  readonly role?: 'admin' | 'member';
  readonly projectId?: string;
  readonly session?: boolean;
}

const CALLERS: readonly { readonly who: string; readonly limits: Limits }[] = [
  { who: 'a full key', limits: {} },
  { who: 'a full session', limits: { session: true } },
  { who: 'a member key', limits: { role: 'member' } },
  { who: 'a member session', limits: { role: 'member', session: true } },
  { who: 'a key limited to project A', limits: { projectId: projectA } },
  { who: 'a session limited to project A', limits: { projectId: projectA, session: true } },
];

const CHECKS: readonly { readonly action: Action; readonly resource: ResourceRef }[] = [
  { action: 'admin', resource: ref('tenant', tenantId) },
  { action: 'read', resource: ref('tenant', tenantId) },
  { action: 'write', resource: ref('project', projectA) },
  { action: 'write', resource: ref('project', projectB) },
];

/** A binding whose store answers `grants` to everything; what each method was asked. */
function harness(limits: Limits, grants: boolean, options: { readonly probe?: boolean } = {}) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => ({
    allowed: grants,
    reason: grants ? 'test: granted' : 'test: not granted',
    evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: 'user:u-1' },
  });
  const binding: AuthzCheckBinding = {
    check: async (_p, action, r) => {
      asked.push(`check ${action} ${r.type}:${r.id}`);
      return decide(action, r);
    },
    checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
    inProject: async () => false,
    recordDecision: (_p, action, r) => {
      asked.push(`recordDecision ${action} ${r.type}:${r.id}`);
    },
    ...(options.probe !== false && {
      probe: async (_p: unknown, action: Action, r: ResourceRef) => {
        asked.push(`probe ${action} ${r.type}:${r.id}`);
        return decide(action, r);
      },
    }),
  };
  const authorizer = createAuthorizer(binding);
  const log = createLogger({ write: () => {} });
  const inHandler = async <T>(
    run: (c: Context<AppEnv>) => Promise<T>,
    principal = true,
  ): Promise<T> => {
    let out: T | undefined;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('log', log);
      c.set('tenantId' as never, tenantId as never);
      if (principal) c.set('principal' as never, userPrincipal('u-1' as UserId, tenantId) as never);
      if (limits.session === true) c.set('sessionId' as never, 'sess-1' as never);
      if (limits.role !== undefined) c.set('tokenRole' as never, limits.role as never);
      if (limits.projectId !== undefined)
        c.set('tokenProjectId' as never, limits.projectId as never);
      await next();
    });
    app.get('/', async (c) => {
      out = await run(c);
      return c.text('ok');
    });
    await app.request('/');
    return out as T;
  };
  /** `authorizer.probe`, which `createAuthorizer` always has. */
  const probe = (c: Context<AppEnv>, action: Action, resource: ResourceRef) => {
    if (authorizer.probe === undefined) throw new Error('createAuthorizer has no probe');
    return authorizer.probe(c, action, resource);
  };
  return { asked, authorizer, probe, inHandler };
}

describe('probe answers as can does, and records nothing', () => {
  for (const grants of [true, false]) {
    for (const caller of CALLERS) {
      test.each(CHECKS)(
        `${caller.who}, a store that ${grants ? 'grants' : 'refuses'}: $action on $resource.type:$resource.id`,
        async ({ action, resource }) => {
          const asCan = harness(caller.limits, grants);
          const canSays = await asCan.inHandler((c) => asCan.authorizer.can(c, action, resource));
          const h = harness(caller.limits, grants);
          const probeSays = await h.inHandler((c) => h.probe(c, action, resource));
          expect(probeSays).toBe(canSays);
          // `can` asked the store, or refused and recorded; `probe` did neither.
          expect(
            asCan.asked.some((a) => a.startsWith('check') || a.startsWith('recordDecision')),
          ).toBe(true);
          const at = `${resource.type}:${resource.id}`;
          expect(h.asked).toEqual(
            asCan.asked[0]?.startsWith('recordDecision') === true ? [] : [`probe ${action} ${at}`],
          );
        },
      );
    }
  }

  test("a key's limits refuse before the store is asked: a member key is never a tenant admin", async () => {
    const h = harness({ role: 'member' }, true);
    expect(await h.inHandler((c) => h.probe(c, 'admin', ref('tenant', tenantId)))).toBe(false);
    const limited = harness({ projectId: projectA }, true);
    expect(
      await limited.inHandler((c) => limited.probe(c, 'write', ref('project', projectB))),
    ).toBe(false);
    expect([...h.asked, ...limited.asked]).toEqual([]);
  });

  test('no principal on the request: false, and nothing asked', async () => {
    const h = harness({}, true);
    const says = await h.inHandler((c) => h.probe(c, 'admin', ref('tenant', tenantId)), false);
    expect(says).toBe(false);
    expect(h.asked).toEqual([]);
  });
});

describe('a binding without probe', () => {
  test('probe asks check, which records, as before', async () => {
    const h = harness({}, true, { probe: false });
    expect(await h.inHandler((c) => h.probe(c, 'admin', ref('tenant', tenantId)))).toBe(true);
    expect(h.asked).toEqual([`check admin tenant:${tenantId}`]);
  });
});

describe('canForDisplay', () => {
  test('an authorizer without probe (one a test builds) answers through can', async () => {
    const asked: string[] = [];
    const authorizer = {
      can: async (_c: unknown, action: Action) => {
        asked.push(`can ${action}`);
        return true;
      },
    } as unknown as Authorizer;
    const h = harness({}, true);
    expect(
      await h.inHandler((c) => canForDisplay(c, authorizer, 'write', ref('project', projectA))),
    ).toBe(true);
    expect(asked).toEqual(['can write']);
  });

  test('an authorizer with probe answers through it, never can', async () => {
    const h = harness({}, false);
    const can = h.authorizer.can;
    const authorizer: Authorizer = {
      ...h.authorizer,
      can: async (...args) => {
        h.asked.push('can');
        return can(...args);
      },
    };
    expect(
      await h.inHandler((c) => canForDisplay(c, authorizer, 'write', ref('project', projectA))),
    ).toBe(false);
    expect(h.asked).toEqual([`probe write project:${projectA}`]);
  });
});

/** Every use of the reads that record nothing in `src`, as `<file>: <name>`, comments left out. */
function displayReads(src: string): string[] {
  const uses = /\b(canForDisplay|isTenantAdminForDisplay)\(|\.probe(\?\.)?\(/g;
  return (readdirSync(src, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) =>
      readFileSync(join(src, file), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((code) => !code.startsWith('*') && !code.startsWith('/'))
        .flatMap((code) => [...code.matchAll(uses)].map((m) => `${file}: ${m[1] ?? '.probe'}`)),
    );
}

describe('what reads without recording', () => {
  test('only these lines read access for display: a new one must show, never decide', () => {
    const found = displayReads(join(dirname(fileURLToPath(import.meta.url)), '..', 'src'));
    // Where they're defined (caller.ts, over `Authorizer.probe`; the
    // authorizer, over the binding's), and the responses that show the
    // caller its own access, each checked to decide nothing: whoami,
    // `/me/permissions` and the judging queue's `can`. A new one fails here
    // until someone has checked the same of it.
    expect(found.sort()).toEqual(
      [
        'caller.ts: .probe',
        'caller.ts: canForDisplay',
        'caller.ts: canForDisplay',
        'caller.ts: isTenantAdminForDisplay',
        'middleware/authorize.ts: .probe',
        'routes/identity.ts: isTenantAdminForDisplay',
        'routes/identity.ts: isTenantAdminForDisplay',
        'routes/judging.ts: canForDisplay',
      ].sort(),
    );
  });
});
