// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's database in the bundled Postgres (`kindgi-dev_postgres`):
 * created when missing, and owned by one folder. The owner is recorded in
 * the database's comment (`{"kindgi":{"root":…,"createdBy":…}}`), so two
 * unrelated folders that resolve to the same project name don't share a
 * database and a tenant without knowing it. Statements go through
 * `docker exec … psql` in the container: the CLI carries no Postgres
 * client, and only manages the bundled Postgres (never a database a
 * `--database-url` names).
 */

import { existsSync } from 'node:fs';

import type { DevProject } from './project.js';

/** The bundled Postgres's container (compose and plain-docker starts alike). */
export const BUNDLED_POSTGRES_CONTAINER = 'kindgi-dev_postgres';

/** One SQL statement's tuples-only output, or why it failed. */
export type SqlRunner = (
  sql: string,
) => Promise<
  { readonly ok: true; readonly out: string } | { readonly ok: false; readonly error: string }
>;

/** Who owns a project database, as its comment records it. */
export interface DatabaseOwner {
  readonly root: string;
  readonly createdBy: string;
}

export type EnsureOutcome =
  | { readonly kind: 'created' }
  | { readonly kind: 'exists' }
  /** The owner's folder moved (the recorded one is gone): the database is this folder's now. */
  | { readonly kind: 'adopted'; readonly previousRoot: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export interface ProjectDatabases {
  /** The URL the runtime connects with, for a database in the bundled Postgres. */
  urlFor(database: string): string;
  /** Make sure the project's database exists and belongs to this folder. */
  ensure(project: DevProject, cliVersion: string): Promise<EnsureOutcome>;
  /** Drop the project's database, disconnecting whoever is on it (`--reset`). */
  drop(
    database: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  /** Whether a database is there (the old shared `kindgi` one, say). */
  exists(database: string): Promise<boolean>;
}

/**
 * The bundled Postgres's project databases. `run` executes one statement
 * in the container's `kindgi` database; `baseUrl` is the shared
 * database's URL (only the database name changes per project).
 */
export function createProjectDatabases(input: {
  readonly run: SqlRunner;
  readonly baseUrl: string;
  /** Whether a folder exists (test seam). */
  readonly folderExists?: (path: string) => boolean;
}): ProjectDatabases {
  const { run } = input;
  const folderExists = input.folderExists ?? existsSync;

  const exists = async (database: string): Promise<boolean> => {
    const found = await run(`SELECT 1 FROM pg_database WHERE datname = ${literal(database)}`);
    return found.ok && found.out.trim() === '1';
  };

  const owner = async (database: string): Promise<DatabaseOwner | undefined> => {
    const read = await run(
      `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = ${literal(database)}`,
    );
    if (!read.ok) return undefined;
    try {
      const parsed = JSON.parse(read.out.trim()) as { kindgi?: Partial<DatabaseOwner> };
      const root = parsed.kindgi?.root;
      return typeof root === 'string'
        ? { root, createdBy: String(parsed.kindgi?.createdBy ?? 'unknown') }
        : undefined;
    } catch {
      return undefined;
    }
  };

  const setOwner = (database: string, value: DatabaseOwner) =>
    run(
      `COMMENT ON DATABASE ${identifier(database)} IS ${literal(JSON.stringify({ kindgi: value }))}`,
    );

  return {
    urlFor(database) {
      const url = new URL(input.baseUrl);
      url.pathname = `/${database}`;
      return url.toString();
    },
    exists,
    async ensure(project, cliVersion) {
      const recorded: DatabaseOwner = { root: project.root, createdBy: cliVersion };
      if (!(await exists(project.database))) {
        const created = await run(`CREATE DATABASE ${identifier(project.database)}`);
        // Two packs of one project starting at once: the other one made it.
        if (!created.ok && !/already exists/.test(created.error)) {
          return {
            kind: 'error',
            message: `could not create ${project.database}: ${created.error}`,
          };
        }
        if (created.ok) {
          const commented = await setOwner(project.database, recorded);
          if (!commented.ok) {
            return {
              kind: 'error',
              message: `could not record ${project.database}'s folder: ${commented.error}`,
            };
          }
          return { kind: 'created' };
        }
      }
      const current = await owner(project.database);
      if (current === undefined) {
        // A database without Kindgi's record (made by hand): this folder's now.
        const commented = await setOwner(project.database, recorded);
        return commented.ok
          ? { kind: 'exists' }
          : {
              kind: 'error',
              message: `could not record ${project.database}'s folder: ${commented.error}`,
            };
      }
      if (current.root === project.root) return { kind: 'exists' };
      if (folderExists(current.root)) {
        return {
          kind: 'refused',
          message: `the database ${project.database} belongs to ${current.root}, another folder whose project is also named "${project.name}". Give this one its own name: set \`project\` in kindgi.config.ts (or \`project\` under [tool.kindgi] in pyproject.toml, or in kindgi.config.json), or pass --database-url.`,
        };
      }
      const moved = await setOwner(project.database, {
        root: project.root,
        createdBy: current.createdBy,
      });
      return moved.ok
        ? { kind: 'adopted', previousRoot: current.root }
        : {
            kind: 'error',
            message: `could not record ${project.database}'s folder: ${moved.error}`,
          };
    },
    async drop(database) {
      const dropped = await run(`DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`);
      return dropped.ok ? { ok: true } : { ok: false, error: dropped.error };
    },
  };
}

/** A database name as a quoted identifier (names from `projectDatabaseName` are already plain). */
function identifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A SQL string literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The real runner: `docker exec kindgi-dev_postgres psql -U kindgi -d kindgi
 * -tA -v ON_ERROR_STOP=1 -c <sql>`, through the CLI's docker helper.
 */
export function bundledSqlRunner(
  docker: (
    args: readonly string[],
  ) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>,
): SqlRunner {
  return async (sql) => {
    const out = await docker([
      'exec',
      BUNDLED_POSTGRES_CONTAINER,
      'psql',
      '-U',
      'kindgi',
      '-d',
      'kindgi',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ]);
    return out.code === 0
      ? { ok: true, out: out.stdout }
      : { ok: false, error: out.stderr.trim() || `psql exited ${out.code ?? 'without a code'}` };
  };
}
