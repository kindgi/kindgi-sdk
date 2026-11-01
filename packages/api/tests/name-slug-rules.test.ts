// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, test, vi } from 'vitest';

import {
  makeInMemoryOrgBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import { SLUG, SLUG_MAX, SLUG_RULE, type TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * An org's, a project's and a team's name and slug, on create and on
 * update: a slug by `@kindgi/types`' rule, a name not blank and of at most
 * 100 code points. An update checks a sent value as create does, but a
 * stored value sent back unchanged passes and isn't written again.
 */

const TOKEN = 'name-slug-rules-token';
const tenantId = randomUUID() as TenantId;

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

/** One code point outside the Basic Multilingual Plane: two UTF-16 units. */
const ASTRAL = String.fromCodePoint(0x1f600);

const SLUG_REFUSED = `\`slug\` must be ${SLUG_RULE}`;
const NAME_REFUSED = '`name` must be a non-empty string of at most 100 characters';

/** A slug stored before the rule: a space and capitals. */
const OLD_SLUG = 'Foo Bar';

type Stored = { readonly name: string; readonly slug: string };

/** The binding as the tests see it: one that stores a row as given, and its reads and writes. */
type Family = {
  readonly path: string;
  readonly make: () => {
    readonly app: ReturnType<typeof createApp>;
    readonly store: (row: Stored) => Promise<string>;
    readonly read: (id: string) => Promise<Stored | undefined>;
    readonly gets: () => number;
    readonly patches: () => readonly unknown[];
  };
};

const families: readonly Family[] = [
  {
    path: '/v1/orgs',
    make: () => {
      const binding = makeInMemoryOrgBinding();
      const get = vi.spyOn(binding, 'get');
      const update = vi.spyOn(binding, 'update');
      const app = createApp({
        ...createStubAppBindings(),
        resolveToken,
        runHandler,
        orgBinding: binding,
      });
      return {
        app,
        store: async (row) => {
          const made = await binding.create(tenantId, row);
          if (made.kind !== 'ok') throw new Error(made.kind);
          get.mockClear();
          return made.orgId as unknown as string;
        },
        read: (id) => binding.get(tenantId, id as never),
        gets: () => get.mock.calls.length,
        patches: () => update.mock.calls.map((call) => call[2]),
      };
    },
  },
  {
    path: '/v1/projects',
    make: () => {
      const trio = makeInMemoryProjectBinding();
      const get = vi.spyOn(trio.projects, 'get');
      const update = vi.spyOn(trio.projects, 'update');
      const app = createApp({
        ...createStubAppBindings(),
        resolveToken,
        runHandler,
        projectBinding: trio.projects,
        projectMembershipBinding: trio.memberships,
        teamProjectGrantBinding: trio.grants,
      });
      return {
        app,
        store: async (row) => {
          const made = await trio.projects.create(tenantId, row);
          if (made.kind !== 'ok') throw new Error(made.kind);
          get.mockClear();
          return made.projectId as unknown as string;
        },
        read: (id) => trio.projects.get(tenantId, id as never),
        gets: () => get.mock.calls.length,
        patches: () => update.mock.calls.map((call) => call[2]),
      };
    },
  },
  {
    path: '/v1/teams',
    make: () => {
      const pair = makeInMemoryTeamBinding();
      const get = vi.spyOn(pair.teams, 'get');
      const update = vi.spyOn(pair.teams, 'update');
      const app = createApp({
        ...createStubAppBindings(),
        resolveToken,
        runHandler,
        teamBinding: pair.teams,
        teamMembershipBinding: pair.memberships,
      });
      return {
        app,
        store: async (row) => {
          const made = await pair.teams.create(tenantId, row);
          if (made.kind !== 'ok') throw new Error(made.kind);
          get.mockClear();
          return made.teamId as unknown as string;
        },
        read: (id) => pair.teams.get(tenantId, id as never),
        gets: () => get.mock.calls.length,
        patches: () => update.mock.calls.map((call) => call[2]),
      };
    },
  },
];

function send(
  app: ReturnType<typeof createApp>,
  method: 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function refusal(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return { status: res.status, code: body.error.code, message: body.error.message };
}

const longestSlug = `a${'b'.repeat(SLUG_MAX - 1)}`;

describe.each(families)('$path: create', ({ path, make }) => {
  test.each(['Foo', 'a b', 'a/b', 'a_b', '-a', '', `${longestSlug}c`, 5])(
    'refuses the slug %j',
    async (slug) => {
      const { app } = make();
      expect(await refusal(await send(app, 'POST', path, { name: 'N', slug }))).toEqual({
        status: 400,
        code: 'bad-input',
        message: SLUG_REFUSED,
      });
    },
  );

  test.each(['a', '0', 'a-b', 'a--b', 'a-', longestSlug])('takes the slug %j', async (slug) => {
    const { app } = make();
    expect((await send(app, 'POST', path, { name: 'N', slug })).status).toBe(201);
  });

  test.each([
    ['blank', '   '],
    ['empty', ''],
    ['101 code points', 'x'.repeat(101)],
    ['not a string', 5],
  ])('refuses a name that is %s', async (_what, name) => {
    const { app } = make();
    expect(await refusal(await send(app, 'POST', path, { name, slug: 'a' }))).toEqual({
      status: 400,
      code: 'bad-input',
      message: NAME_REFUSED,
    });
  });

  test('takes a name of 100 code points, also outside the BMP, where that is 200 UTF-16 units', async () => {
    const { app } = make();
    expect((await send(app, 'POST', path, { name: 'x'.repeat(100), slug: 'a' })).status).toBe(201);
    expect(ASTRAL.repeat(100)).toHaveLength(200);
    expect((await send(app, 'POST', path, { name: ASTRAL.repeat(100), slug: 'b' })).status).toBe(
      201,
    );
  });
});

describe.each(families)('$path: update', ({ path, make }) => {
  test.each([
    ['a new slug that fails the rule', { slug: 'Foo' }, SLUG_REFUSED],
    ['an empty slug', { slug: '' }, SLUG_REFUSED],
    ['an empty name', { name: '' }, NAME_REFUSED],
    ['a blank name', { name: '  ' }, NAME_REFUSED],
    ['a name of 101 code points', { name: 'x'.repeat(101) }, NAME_REFUSED],
  ])('refuses %s, and changes nothing', async (_what, body, message) => {
    const { app, store, read, patches } = make();
    const id = await store({ name: 'Shop', slug: 'shop' });
    expect(await refusal(await send(app, 'PATCH', `${path}/${id}`, body))).toEqual({
      status: 400,
      code: 'bad-input',
      message,
    });
    expect(patches()).toEqual([]);
    expect(await read(id)).toMatchObject({ name: 'Shop', slug: 'shop' });
  });

  test('a stored slug that fails the rule, sent back unchanged with a new name, passes and is not written', async () => {
    const { app, store, read, patches } = make();
    const id = await store({ name: 'Shop', slug: OLD_SLUG });
    const res = await send(app, 'PATCH', `${path}/${id}`, { name: 'Shop EU', slug: OLD_SLUG });
    expect(res.status).toBe(204);
    expect(patches()).toEqual([{ name: 'Shop EU' }]);
    expect(await read(id)).toMatchObject({ name: 'Shop EU', slug: OLD_SLUG });
  });

  test('the stored slug compares exactly: another case of it is a new slug, and refused', async () => {
    const { app, store } = make();
    const id = await store({ name: 'Shop', slug: OLD_SLUG });
    expect(
      await refusal(await send(app, 'PATCH', `${path}/${id}`, { slug: OLD_SLUG.toLowerCase() })),
    ).toMatchObject({ status: 400, message: SLUG_REFUSED });
  });

  test('a stored name over the limit, sent back unchanged, passes and is not written', async () => {
    const { app, store, read, patches } = make();
    const long = 'x'.repeat(101);
    const id = await store({ name: long, slug: 'shop' });
    const res = await send(app, 'PATCH', `${path}/${id}`, { name: long, slug: 'shop-eu' });
    expect(res.status).toBe(204);
    expect(patches()).toEqual([{ slug: 'shop-eu' }]);
    expect(await read(id)).toMatchObject({ name: long, slug: 'shop-eu' });
  });

  test('a name-only update of a row with a stored failing slug passes, and reads no row', async () => {
    const { app, store, gets } = make();
    const id = await store({ name: 'Shop', slug: OLD_SLUG });
    expect((await send(app, 'PATCH', `${path}/${id}`, { name: 'Shop EU' })).status).toBe(204);
    expect(gets()).toBe(0);
  });
});

const document = JSON.parse(
  await readFile(new URL('../openapi.json', import.meta.url), 'utf8'),
) as {
  components: { schemas: Record<string, { properties: Record<string, Record<string, unknown>> }> };
};

/** A field of a schema in the emitted document. */
function field(schema: string, name: string): Record<string, unknown> {
  const found = document.components.schemas[schema]?.properties[name];
  if (found === undefined) throw new Error(`${schema}.${name} is not in openapi.json`);
  return found;
}

const CONSTRAINTS = ['pattern', 'maxLength', 'minLength'];

describe('openapi.json: the create bodies carry the rules, the PATCH bodies say them in words', () => {
  test.each(['OrgSpec', 'TeamSpec', 'ProjectSpec'])(
    '%s: the slug rule and the name limit',
    (schema) => {
      expect(field(schema, 'slug')).toMatchObject({ pattern: SLUG.source, maxLength: SLUG_MAX });
      expect(field(schema, 'name')).toMatchObject({ minLength: 1, maxLength: 100 });
    },
  );

  test.each(['OrgPatch', 'TeamPatch', 'ProjectPatch'])(
    '%s: no constraint on the slug or the name, so a stored value sent back passes a client',
    (schema) => {
      for (const name of ['slug', 'name']) {
        for (const constraint of CONSTRAINTS)
          expect(field(schema, name)).not.toHaveProperty(constraint);
        expect(field(schema, name).description).toContain('sent back unchanged passes');
      }
    },
  );

  test.each([
    'MintTokenBody',
    'RegisterScheduleBody',
    'RegisterWebhookTriggerBody',
    'RegisterMailTriggerBody',
  ])('%s: the label limit', (schema) => {
    expect(field(schema, 'label')).toMatchObject({ minLength: 1, maxLength: 100 });
  });

  test.each(['PatchScheduleBody', 'PatchWebhookTriggerBody', 'PatchMailTriggerBody'])(
    '%s: no constraint on the label',
    (schema) => {
      for (const constraint of CONSTRAINTS)
        expect(field(schema, 'label')).not.toHaveProperty(constraint);
      expect(field(schema, 'label').description).toContain('sent back unchanged passes');
    },
  );

  test('OpenConversationBody: the title limit', () => {
    expect(field('OpenConversationBody', 'title')).toMatchObject({ maxLength: 200 });
  });
});
