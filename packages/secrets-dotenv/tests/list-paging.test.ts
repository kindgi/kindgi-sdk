// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `list` pages by name: at most `limit` secrets, and a `nextCursor`
 * while more remain. Walking the cursors gives every name once, in order.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, TenantId } from '@kindgi/types';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createDotenvSecretBinding } from '../src/index.js';

let dir: string;
const SCOPE: Scope = { kind: 'tenant', tenantId: 't' as TenantId };
const LOCAL = 'local' as EnvName;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-dotenv-paging-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const names = (count: number, prefix = 'KEY_'): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
const putEnv = (keys: readonly string[]): Promise<void> =>
  writeFile(join(dir, '.env'), keys.map((k) => `${k}=v\n`).join(''));

type Binding = ReturnType<typeof createDotenvSecretBinding>;

/** Every page of a walk, as the names in each; `[]` pages would loop, so it stops at 20. */
async function walk(
  b: Binding,
  input: { readonly limit: number; readonly namePrefix?: string },
): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: Cursor | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await b.list({
      scope: SCOPE,
      envName: LOCAL,
      ...input,
      ...(cursor !== undefined && { cursor }),
    });
    pages.push(page.data.map((r) => r.name));
    if (page.nextCursor === undefined) return pages;
    cursor = page.nextCursor;
  }
  throw new Error('the walk never ended');
}

describe('secrets-dotenv list pages by name', () => {
  test('26 secrets at the default limit of 25: a page of 25, then 1', async () => {
    await putEnv(names(26));
    const pages = await walk(createDotenvSecretBinding({ packDir: dir }), { limit: 25 });
    expect(pages.map((p) => p.length)).toEqual([25, 1]);
    expect(pages.flat()).toEqual(names(26));
  });

  test('101 secrets at the most of 100: a page of 100, then 1', async () => {
    await putEnv(names(101));
    const pages = await walk(createDotenvSecretBinding({ packDir: dir }), { limit: 100 });
    expect(pages.map((p) => p.length)).toEqual([100, 1]);
    expect(pages.flat()).toEqual(names(101));
  });

  test('a last page that ends exactly at the end has no cursor', async () => {
    await putEnv(names(50));
    const pages = await walk(createDotenvSecretBinding({ packDir: dir }), { limit: 25 });
    expect(pages.map((p) => p.length)).toEqual([25, 25]);
  });

  test('namePrefix filters before the page', async () => {
    await putEnv([...names(5, 'B_'), ...names(30, 'A_')]);
    const pages = await walk(createDotenvSecretBinding({ packDir: dir }), {
      limit: 25,
      namePrefix: 'A_',
    });
    expect(pages.map((p) => p.length)).toEqual([25, 5]);
    expect(pages.flat()).toEqual(names(30, 'A_'));
  });

  test('a name added between pages neither repeats nor skips another', async () => {
    await putEnv(['A', 'B', 'C', 'D']);
    const b = createDotenvSecretBinding({ packDir: dir });
    const first = await b.list({ scope: SCOPE, envName: LOCAL, limit: 2 });
    expect(first.data.map((r) => r.name)).toEqual(['A', 'B']);
    // One before the cursor, one after it.
    await putEnv(['A', 'AA', 'B', 'BB', 'C', 'D']);
    const second = await b.list({
      scope: SCOPE,
      envName: LOCAL,
      limit: 2,
      ...(first.nextCursor !== undefined && { cursor: first.nextCursor }),
    });
    expect(second.data.map((r) => r.name)).toEqual(['BB', 'C']);
  });

  test('a cursor that is not one starts at the first page, as the durable stores do', async () => {
    await putEnv(names(3));
    const b = createDotenvSecretBinding({ packDir: dir });
    for (const cursor of ['not-a-cursor', Buffer.from('{"n":null}').toString('base64url')]) {
      const page = await b.list({
        scope: SCOPE,
        envName: LOCAL,
        limit: 2,
        cursor: cursor as Cursor,
      });
      expect(page.data.map((r) => r.name)).toEqual(names(2));
    }
  });

  test("issuedCursor: a list page's cursor is one; anything else, and any versions cursor, is not", async () => {
    await putEnv(names(3));
    const b = createDotenvSecretBinding({ packDir: dir });
    const { nextCursor } = await b.list({ scope: SCOPE, envName: LOCAL, limit: 2 });
    if (nextCursor === undefined) throw new Error('no cursor after a page of 2 of 3');
    expect(b.issuedCursor?.('secrets', nextCursor)).toBe(true);
    expect(b.issuedCursor?.('versions', nextCursor)).toBe(false);
    for (const made of ['not-a-cursor', Buffer.from('{"n":null}').toString('base64url')]) {
      expect(b.issuedCursor?.('secrets', made as Cursor)).toBe(false);
    }
  });

  test('includeRevoked lists the same: nothing is revoked in env files', async () => {
    await putEnv(names(3));
    const b = createDotenvSecretBinding({ packDir: dir });
    const plain = await b.list({ scope: SCOPE, envName: LOCAL, limit: 25 });
    const revoked = await b.list({ scope: SCOPE, envName: LOCAL, limit: 25, includeRevoked: true });
    expect(revoked).toEqual(plain);
  });
});
