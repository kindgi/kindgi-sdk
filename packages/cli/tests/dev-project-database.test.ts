// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  type SqlRunner,
  bundledSqlRunner,
  createProjectDatabases,
} from '../src/dev/project-database.js';
import type { DevProject } from '../src/dev/project.js';

/**
 * A stand-in for the bundled Postgres: the statements `ensure` and `drop`
 * send, against a map of databases and their comments.
 */
function fakePostgres(initial: Record<string, string | null> = {}) {
  const databases = new Map<string, string | null>(Object.entries(initial));
  const sent: string[] = [];
  let failNext: { readonly match: RegExp; readonly error: string } | undefined;
  const unquote = (s: string) => s.replace(/^"|"$/g, '').replace(/""/g, '"');
  const unliteral = (s: string) => s.replace(/^'|'$/g, '').replace(/''/g, "'");
  const run: SqlRunner = async (sql) => {
    sent.push(sql);
    if (failNext?.match.test(sql)) {
      const error = failNext.error;
      failNext = undefined;
      return { ok: false, error };
    }
    let m = /^SELECT 1 FROM pg_database WHERE datname = ('(?:[^']|'')*')$/.exec(sql);
    if (m?.[1] !== undefined) return { ok: true, out: databases.has(unliteral(m[1])) ? '1\n' : '' };
    m =
      /^SELECT shobj_description\(oid, 'pg_database'\) FROM pg_database WHERE datname = ('(?:[^']|'')*')$/.exec(
        sql,
      );
    if (m?.[1] !== undefined) return { ok: true, out: `${databases.get(unliteral(m[1])) ?? ''}\n` };
    m = /^CREATE DATABASE ("(?:[^"]|"")*")$/.exec(sql);
    if (m?.[1] !== undefined) {
      const name = unquote(m[1]);
      if (databases.has(name))
        return { ok: false, error: `ERROR:  database "${name}" already exists` };
      databases.set(name, null);
      return { ok: true, out: '' };
    }
    m = /^COMMENT ON DATABASE ("(?:[^"]|"")*") IS ('(?:[^']|'')*')$/.exec(sql);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      databases.set(unquote(m[1]), unliteral(m[2]));
      return { ok: true, out: '' };
    }
    m = /^DROP DATABASE IF EXISTS ("(?:[^"]|"")*") WITH \(FORCE\)$/.exec(sql);
    if (m?.[1] !== undefined) {
      databases.delete(unquote(m[1]));
      return { ok: true, out: '' };
    }
    return { ok: false, error: `unexpected statement: ${sql}` };
  };
  return {
    run,
    databases,
    sent,
    failOnce(match: RegExp, error: string) {
      failNext = { match, error };
    },
  };
}

const project = (overrides: Partial<DevProject> = {}): DevProject => ({
  name: 'acme',
  nameFrom: 'repository',
  root: '/work/acme',
  database: 'kindgi_acme',
  tenantId: '00000000-0000-5000-8000-000000000001',
  userId: '00000000-0000-5000-8000-000000000002',
  ...overrides,
});

const owner = (root: string, createdBy = '0.1.3') =>
  JSON.stringify({ kindgi: { root, createdBy } });

describe('createProjectDatabases', () => {
  test("urlFor swaps only the database name in the bundled Postgres's URL", () => {
    const dbs = createProjectDatabases({
      run: fakePostgres().run,
      baseUrl: 'postgres://kindgi:kindgi@127.0.0.1:51741/kindgi',
    });
    expect(dbs.urlFor('kindgi_acme__login')).toBe(
      'postgres://kindgi:kindgi@127.0.0.1:51741/kindgi_acme__login',
    );
  });

  test('a missing database is created and records its folder and the CLI version', async () => {
    const pg = fakePostgres();
    const dbs = createProjectDatabases({ run: pg.run, baseUrl: 'postgres://k@h/kindgi' });
    expect(await dbs.ensure(project(), '0.1.3')).toEqual({ kind: 'created' });
    expect(JSON.parse(pg.databases.get('kindgi_acme') ?? 'null')).toEqual({
      kindgi: { root: '/work/acme', createdBy: '0.1.3' },
    });
    expect(await dbs.exists('kindgi_acme')).toBe(true);
  });

  test("the same folder again: it's there, nothing is changed", async () => {
    const pg = fakePostgres({ kindgi_acme: owner('/work/acme') });
    const dbs = createProjectDatabases({ run: pg.run, baseUrl: 'postgres://k@h/kindgi' });
    expect(await dbs.ensure(project(), '0.1.4')).toEqual({ kind: 'exists' });
    expect(pg.sent.some((s) => s.startsWith('CREATE') || s.startsWith('COMMENT'))).toBe(false);
  });

  test('another folder whose project has the same name is refused while that folder exists', async () => {
    const pg = fakePostgres({ kindgi_acme: owner('/elsewhere/acme') });
    const dbs = createProjectDatabases({
      run: pg.run,
      baseUrl: 'postgres://k@h/kindgi',
      folderExists: () => true,
    });
    const outcome = await dbs.ensure(project(), '0.1.3');
    expect(outcome).toEqual({
      kind: 'refused',
      message:
        'the database kindgi_acme belongs to /elsewhere/acme, another folder whose project is also named "acme". Give this one its own name: set `project` in kindgi.config.ts (or `project` under [tool.kindgi] in pyproject.toml), or pass --database-url.',
    });
    expect(pg.databases.get('kindgi_acme')).toBe(owner('/elsewhere/acme'));
  });

  test('a moved project: the recorded folder is gone, so this folder adopts it (keeping who created it)', async () => {
    const pg = fakePostgres({ kindgi_acme: owner('/old/acme', '0.1.2') });
    const dbs = createProjectDatabases({
      run: pg.run,
      baseUrl: 'postgres://k@h/kindgi',
      folderExists: () => false,
    });
    expect(await dbs.ensure(project(), '0.1.3')).toEqual({
      kind: 'adopted',
      previousRoot: '/old/acme',
    });
    expect(JSON.parse(pg.databases.get('kindgi_acme') ?? 'null')).toEqual({
      kindgi: { root: '/work/acme', createdBy: '0.1.2' },
    });
  });

  test("a database without Kindgi's record (made by hand) becomes this folder's", async () => {
    const pg = fakePostgres({ kindgi_acme: null });
    const dbs = createProjectDatabases({ run: pg.run, baseUrl: 'postgres://k@h/kindgi' });
    expect(await dbs.ensure(project(), '0.1.3')).toEqual({ kind: 'exists' });
    expect(JSON.parse(pg.databases.get('kindgi_acme') ?? 'null')).toMatchObject({
      kindgi: { root: '/work/acme' },
    });
  });

  test("two packs of one project starting at once: the loser's CREATE finds it made, and checks the owner", async () => {
    const pg = fakePostgres();
    const dbs = createProjectDatabases({ run: pg.run, baseUrl: 'postgres://k@h/kindgi' });
    // The other pack's CREATE and COMMENT land between this one's check and its CREATE.
    const racing: SqlRunner = async (sql) => {
      if (sql.startsWith('CREATE DATABASE') && !pg.databases.has('kindgi_acme')) {
        pg.databases.set('kindgi_acme', owner('/work/acme'));
      }
      return pg.run(sql);
    };
    const raced = createProjectDatabases({ run: racing, baseUrl: 'postgres://k@h/kindgi' });
    expect(await raced.ensure(project(), '0.1.3')).toEqual({ kind: 'exists' });
    expect(await dbs.exists('kindgi_acme')).toBe(true);
  });

  test('a CREATE that fails for another reason is an error that says why', async () => {
    const pg = fakePostgres();
    pg.failOnce(/^CREATE DATABASE/, 'ERROR:  permission denied to create database');
    const dbs = createProjectDatabases({ run: pg.run, baseUrl: 'postgres://k@h/kindgi' });
    expect(await dbs.ensure(project(), '0.1.3')).toEqual({
      kind: 'error',
      message: 'could not create kindgi_acme: ERROR:  permission denied to create database',
    });
  });

  test('drop disconnects whoever is on it (WITH (FORCE)), and a missing database is fine', async () => {
    const pg = fakePostgres({ kindgi_acme: owner('/work/acme') });
    const dbs = createProjectDatabases({ run: pg.run, baseUrl: 'postgres://k@h/kindgi' });
    expect(await dbs.drop('kindgi_acme')).toEqual({ ok: true });
    expect(pg.sent).toContain('DROP DATABASE IF EXISTS "kindgi_acme" WITH (FORCE)');
    expect(await dbs.drop('kindgi_acme')).toEqual({ ok: true });
    expect(await dbs.exists('kindgi_acme')).toBe(false);
  });

  test('a folder path with a quote is a literal, never SQL', async () => {
    const pg = fakePostgres();
    const dbs = createProjectDatabases({ run: pg.run, baseUrl: 'postgres://k@h/kindgi' });
    await dbs.ensure(project({ root: "/work/o'brien" }), '0.1.3');
    expect(pg.sent).toContain(
      `COMMENT ON DATABASE "kindgi_acme" IS '${JSON.stringify({ kindgi: { root: "/work/o''brien", createdBy: '0.1.3' } })}'`,
    );
    expect(JSON.parse(pg.databases.get('kindgi_acme') ?? 'null')).toMatchObject({
      kindgi: { root: "/work/o'brien" },
    });
  });
});

describe('bundledSqlRunner', () => {
  test('runs psql in the bundled container, tuples-only, stopping on the first error', async () => {
    const calls: (readonly string[])[] = [];
    const run = bundledSqlRunner(async (args) => {
      calls.push(args);
      return { code: 0, stdout: '1\n', stderr: '' };
    });
    expect(await run('SELECT 1')).toEqual({ ok: true, out: '1\n' });
    expect(calls[0]).toEqual([
      'exec',
      'kindgi-dev_postgres',
      'psql',
      '-U',
      'kindgi',
      '-d',
      'kindgi',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'SELECT 1',
    ]);
  });

  test("a failure carries psql's stderr, or the exit code when it printed none", async () => {
    expect(
      await bundledSqlRunner(async () => ({ code: 1, stdout: '', stderr: 'ERROR:  boom\n' }))('x'),
    ).toEqual({
      ok: false,
      error: 'ERROR:  boom',
    });
    expect(await bundledSqlRunner(async () => ({ code: 2, stdout: '', stderr: '' }))('x')).toEqual({
      ok: false,
      error: 'psql exited 2',
    });
  });
});
