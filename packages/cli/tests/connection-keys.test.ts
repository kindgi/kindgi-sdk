// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The key pair `kindgi dev` gives the runtime for connections' token sets:
 * one per dev database, made once, kept owner-only, removed only with the
 * bundled database on `--reset`; and the words around it (the redirect
 * URI, the changed-key hint, the new-port note).
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type DevConnectionKeys,
  changedKeyHint,
  connectRedirectUri,
  connectionDatabaseId,
  connectionKeysRoot,
  devConnectionKeys,
  notePort,
  removeDevConnectionKeys,
} from '../src/dev/connection-keys.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-dev-connection-keys-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const mode = async (path: string) => (await stat(path)).mode & 0o777;

async function on(database: { readonly bundled: string } | { readonly url: string }) {
  const keys = await devConnectionKeys(home, database);
  if (keys.kind !== 'on') throw new Error(`connections off: ${keys.reason}`);
  return keys.keys;
}

describe('devConnectionKeys', () => {
  test('a pair of 32-byte keys on the first start, the same pair after', async () => {
    const first = await on({ bundled: 'kindgi_acme' });
    expect(first.folder).toBe(join(connectionKeysRoot(home), 'kindgi_acme'));
    expect(first.made).toBe(true);
    const local = await readFile(first.localKeyPath);
    const aad = await readFile(first.aadKeyPath);
    expect(local).toHaveLength(32);
    expect(aad).toHaveLength(32);
    expect(local.equals(aad)).toBe(false);

    const again = await on({ bundled: 'kindgi_acme' });
    expect(again.made).toBe(false);
    expect((await readFile(again.localKeyPath)).equals(local)).toBe(true);
    expect((await readFile(again.aadKeyPath)).equals(aad)).toBe(true);
  });

  test('one pair for each database', async () => {
    const acme = await on({ bundled: 'kindgi_acme' });
    const other = await on({ bundled: 'kindgi_other' });
    expect(other.folder).not.toBe(acme.folder);
    const theirs = await readFile(other.localKeyPath);
    expect(theirs.equals(await readFile(acme.localKeyPath))).toBe(false);
  });

  test('two starts at once keep one pair, and leave no other file', async () => {
    const [a, b] = await Promise.all([
      on({ bundled: 'kindgi_acme' }),
      on({ bundled: 'kindgi_acme' }),
    ]);
    expect(a.localKeyPath).toBe(b.localKeyPath);
    expect(a.made || b.made).toBe(true);
    expect((await readdir(a.folder)).sort()).toEqual(['aad.key', 'local.key']);
  });

  test.skipIf(process.platform === 'win32')(
    'owner-only: the keys 0600, the folder 0700',
    async () => {
      const keys = await on({ bundled: 'kindgi_acme' });
      expect(await mode(keys.localKeyPath)).toBe(0o600);
      expect(await mode(keys.aadKeyPath)).toBe(0o600);
      expect(await mode(keys.folder)).toBe(0o700);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a key made looser by hand is kept, and made 0600 again',
    async () => {
      const keys = await on({ bundled: 'kindgi_acme' });
      const local = await readFile(keys.localKeyPath);
      await chmod(keys.localKeyPath, 0o644);
      const again = await on({ bundled: 'kindgi_acme' });
      expect(again.made).toBe(false);
      expect(await mode(keys.localKeyPath)).toBe(0o600);
      expect((await readFile(keys.localKeyPath)).equals(local)).toBe(true);
    },
  );

  test("a key file that isn't 32 bytes is refused, never replaced: connections are off", async () => {
    const keys = await on({ bundled: 'kindgi_acme' });
    await writeFile(keys.aadKeyPath, 'short');
    const answer = await devConnectionKeys(home, { bundled: 'kindgi_acme' });
    expect(answer.kind).toBe('off');
    if (answer.kind === 'off') {
      expect(answer.reason).toContain(`${keys.aadKeyPath} isn't a 32-byte key file`);
      expect(answer.reason).toContain(keys.folder);
    }
    expect(await readFile(keys.aadKeyPath, 'utf8')).toBe('short');
  });

  test('a folder where a key goes is refused too', async () => {
    const folder = join(connectionKeysRoot(home), 'kindgi_acme');
    await mkdir(join(folder, 'local.key'), { recursive: true });
    const answer = await devConnectionKeys(home, { bundled: 'kindgi_acme' });
    expect(answer.kind).toBe('off');
  });

  test('off, with the reason, with no home or no folder name', async () => {
    expect(await devConnectionKeys(undefined, { bundled: 'kindgi_acme' })).toEqual({
      kind: 'off',
      reason: "there's no home folder to keep their keys in (HOME is empty)",
    });
    const named = await devConnectionKeys(home, { url: 'not a url' });
    expect(named.kind).toBe('off');
    if (named.kind === 'off') expect(named.reason).toContain("couldn't name a folder");
  });
});

describe('connectionDatabaseId', () => {
  test("the bundled database's own name, when it's a safe folder name", () => {
    expect(connectionDatabaseId({ bundled: 'kindgi_acme' })).toBe('kindgi_acme');
    for (const name of ['../kindgi_acme', 'Kindgi_Acme', 'kindgi acme', '']) {
      expect(connectionDatabaseId({ bundled: name }), name).toBeUndefined();
    }
  });

  test('a named database: by host, port and name, hashed; never its user or password', () => {
    const id = connectionDatabaseId({ url: 'postgres://alice:s3cret@db.acme.test:5432/app' });
    expect(id).toMatch(/^url-[0-9a-f]{16}$/);
    expect(id).not.toContain('alice');
    expect(id).not.toContain('s3cret');
    for (const same of [
      'postgres://bob:other@db.acme.test:5432/app',
      'postgres://alice@DB.ACME.TEST/app',
      'postgresql://alice:s3cret@db.acme.test:5432/app?sslmode=require',
    ]) {
      expect(connectionDatabaseId({ url: same }), same).toBe(id);
    }
    for (const other of [
      'postgres://alice:s3cret@db.acme.test:5433/app',
      'postgres://alice:s3cret@db.acme.test:5432/app2',
      'postgres://alice:s3cret@db2.acme.test:5432/app',
    ]) {
      expect(connectionDatabaseId({ url: other }), other).not.toBe(id);
    }
  });

  test("a socket, and Postgres's default database (the user's name)", () => {
    const socket = connectionDatabaseId({ url: 'postgres:///app?host=/var/run/postgresql' });
    expect(socket).toMatch(/^url-[0-9a-f]{16}$/);
    expect(socket).not.toBe(connectionDatabaseId({ url: 'postgres://localhost/app' }));
    expect(connectionDatabaseId({ url: 'postgres://alice@localhost' })).toBe(
      connectionDatabaseId({ url: 'postgres://alice@localhost/alice' }),
    );
    expect(connectionDatabaseId({ url: 'not a url' })).toBeUndefined();
  });
});

describe('removeDevConnectionKeys', () => {
  test('--reset removes the pair and keeps the ports list; the next start makes a new pair', async () => {
    const keys = await on({ bundled: 'kindgi_acme' });
    const local = await readFile(keys.localKeyPath);
    expect(await notePort(keys.folder, 4000)).toBe(true);

    expect(await removeDevConnectionKeys(home, 'kindgi_acme')).toBe(true);
    expect(await readdir(keys.folder)).toEqual(['ports.json']);
    expect(await removeDevConnectionKeys(home, 'kindgi_acme')).toBe(false);

    const again = await on({ bundled: 'kindgi_acme' });
    expect(again.made).toBe(true);
    expect((await readFile(again.localKeyPath)).equals(local)).toBe(false);
    expect(await notePort(again.folder, 4000)).toBe(false);
  });

  test("only the database it's given; nothing with no home or a name that isn't one", async () => {
    const other = await on({ bundled: 'kindgi_other' });
    await on({ bundled: 'kindgi_acme' });
    expect(await removeDevConnectionKeys(home, 'kindgi_acme')).toBe(true);
    expect((await readdir(other.folder)).sort()).toEqual(['aad.key', 'local.key']);
    expect(await removeDevConnectionKeys(undefined, 'kindgi_other')).toBe(false);
    expect(await removeDevConnectionKeys(home, '../kindgi_other')).toBe(false);
    expect((await readdir(other.folder)).sort()).toEqual(['aad.key', 'local.key']);
  });
});

describe('notePort', () => {
  test('true once for each port, kept in order', async () => {
    const keys = await on({ bundled: 'kindgi_acme' });
    expect(await notePort(keys.folder, 4100)).toBe(true);
    expect(await notePort(keys.folder, 4100)).toBe(false);
    expect(await notePort(keys.folder, 4000)).toBe(true);
    expect(JSON.parse(await readFile(join(keys.folder, 'ports.json'), 'utf8'))).toEqual({
      ports: [4000, 4100],
    });
  });

  test("a list that can't be read starts over", async () => {
    const keys = await on({ bundled: 'kindgi_acme' });
    await writeFile(join(keys.folder, 'ports.json'), '{"ports": ["4000"]}');
    expect(await notePort(keys.folder, 4000)).toBe(true);
    await writeFile(join(keys.folder, 'ports.json'), 'not json');
    expect(await notePort(keys.folder, 4000)).toBe(true);
    expect(await notePort(keys.folder, 4000)).toBe(false);
  });
});

describe('the words', () => {
  test("the redirect URI is the runtime's console callback", () => {
    expect(connectRedirectUri('http://127.0.0.1:4000')).toBe(
      'http://127.0.0.1:4000/console/connect/callback',
    );
  });

  const LOCAL =
    "The secrets' local key changed: tenant 00000000-0000-4000-8000-000000000001's secrets were stored under another one";
  const AAD = "The secrets' AAD key changed: tenant 00000000-0000-4000-8000-000000000001's secrets";

  async function keysOn(made: boolean): Promise<Extract<DevConnectionKeys, { kind: 'on' }>> {
    const keys = await on({ bundled: 'kindgi_acme' });
    return { kind: 'on', keys: { ...keys, made } };
  }

  test('a changed key: the file it names, and the ways out', async () => {
    const keys = await keysOn(false);
    const local = changedKeyHint(LOCAL, keys, true);
    expect(local).toMatch(/^\n/);
    expect(local).toContain(keys.keys.folder);
    expect(local).toContain(`${keys.keys.localKeyPath} isn't the key`);
    expect(local).toContain('kindgi dev --reset');
    expect(local).not.toContain('made at this start');

    const aad = changedKeyHint(AAD, keys, false);
    expect(aad).toContain(`${keys.keys.aadKeyPath} isn't the key`);
    expect(aad).toContain('it never drops yours');
    expect(aad).not.toContain('--reset');

    for (const hint of [local, aad]) {
      for (const path of [keys.keys.localKeyPath, keys.keys.aadKeyPath]) {
        const key = await readFile(path);
        expect(hint).not.toContain(key.toString('hex'));
        expect(hint).not.toContain(key.toString('base64'));
      }
    }
  });

  test('a key made at this start says so', async () => {
    expect(changedKeyHint(LOCAL, await keysOn(true), true)).toContain(
      "It was made at this start: the one they were stored under isn't there.",
    );
  });

  test('nothing for other refusals, or with connections off', async () => {
    const keys = await keysOn(false);
    expect(changedKeyHint('connect ECONNREFUSED 127.0.0.1:55432', keys, true)).toBe('');
    expect(changedKeyHint(LOCAL, { kind: 'off', reason: 'x' }, true)).toBe('');
    expect(changedKeyHint(LOCAL, undefined, true)).toBe('');
  });
});
