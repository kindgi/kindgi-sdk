// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A connection named by id or name, as `kindgi connections update`,
 * `connect --reconnect`, `kindgi connection-choices set` and
 * `mail-triggers --connection` name one, resolved to its id. A connection's
 * name is its label, else its account's label.
 */

import {
  type Connection,
  KindgiApiError,
  type KindgiClient,
  type ListConnectionsFilter,
} from '@kindgi/client';

import { UsageError, extractKindgiError } from './errors.js';
import { PROJECT_ID_RE } from './project-ref.js';

/** A connection as a name is matched against it. */
export interface ConnectionRow {
  readonly connectionId: string;
  /** Its label, else its account's label. */
  readonly name: string;
  readonly app?: string;
  /** Its account's label. */
  readonly account?: string;
  /** `company`, or the person's user id. */
  readonly whose?: string;
}

export type ConnectionResolution =
  | { readonly kind: 'ok'; readonly id: string; readonly row?: ConnectionRow }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly matches: readonly ConnectionRow[] };

/** A connection's name: its label, else its account's label. */
export function connectionName(c: Pick<Connection, 'label' | 'account'>): string {
  return c.label ?? c.account.label;
}

/**
 * A name as the server tells two apart: ignoring case, an emoji's variation
 * selector and how accented letters are encoded (`Support` and `support` are
 * one name).
 */
function comparable(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\uFE0E\uFE0F]/gu, '')
    .toLowerCase();
}

/**
 * A connection id-or-name against a listing: an id goes as it is; a name is
 * matched, and a name that several connections have is ambiguous.
 */
export function resolveConnectionAgainst(
  rows: readonly ConnectionRow[],
  ref: string,
): ConnectionResolution {
  if (PROJECT_ID_RE.test(ref)) {
    const row = rows.find((r) => r.connectionId.toLowerCase() === ref.toLowerCase());
    return { kind: 'ok', id: ref, ...(row !== undefined && { row }) };
  }
  const wanted = comparable(ref);
  const matches = rows.filter((r) => comparable(r.name) === wanted);
  const only = matches[0];
  if (only === undefined) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'ok', id: only.connectionId, row: only };
}

/** How a lookup reads and words the connections a name is matched against. */
export interface ConnectionLookup {
  /** The connections to match a name against; read only for a name. */
  readonly rows: () => Promise<readonly ConnectionRow[]>;
  /** The app they were kept to, if any. */
  readonly app?: string;
  /** The command has `--app` and it wasn't given: an ambiguous name says `--app` narrows it. */
  readonly appNarrows: boolean;
  /** What a name that matches none says next: how to list them. */
  readonly listed: (rows: readonly ConnectionRow[]) => string;
}

/** One connection, in a listing of the ones a name matches. */
function rowWords(r: ConnectionRow): string {
  const at =
    r.account !== undefined && r.app !== undefined
      ? `${r.account} at ${r.app}`
      : (r.account ?? r.app);
  const where = [at, r.whose].filter((w) => w !== undefined).join(', ');
  return [r.name, where, r.connectionId].filter((w) => w !== '').join('  ');
}

/**
 * `ref` as a connection id: an id as it is, a name looked up. A name that
 * names none or several is refused (`UsageError`).
 */
export async function resolveConnectionRef(
  ref: string,
  lookup: ConnectionLookup,
): Promise<{ readonly id: string; readonly row?: ConnectionRow }> {
  if (PROJECT_ID_RE.test(ref)) return { id: ref };
  const rows = await lookup.rows();
  const resolved = resolveConnectionAgainst(rows, ref);
  if (resolved.kind === 'none') {
    const at = lookup.app !== undefined ? ` at ${lookup.app}` : '';
    throw new UsageError(`No connection${at} is named "${ref}". ${lookup.listed(rows)}`);
  }
  if (resolved.kind === 'ambiguous') {
    const listed = resolved.matches.map((m) => `  ${rowWords(m)}`).join('\n');
    const next = lookup.appNarrows
      ? '--app=<app> narrows it; or pass the connection id.'
      : 'Pass the connection id instead.';
    throw new UsageError(
      `"${ref}" names ${resolved.matches.length} connections:\n${listed}\n${next}`,
    );
  }
  return { id: resolved.id, ...(resolved.row !== undefined && { row: resolved.row }) };
}

interface Page<T> {
  readonly data: readonly T[];
  readonly hasMore?: boolean;
  readonly nextCursor?: string;
}

/** Every row of a listing, following `nextCursor` to the last page. */
export async function everyPage<T>(read: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await read(cursor);
    rows.push(...page.data);
    if (page.hasMore !== true || page.nextCursor === undefined || page.nextCursor === '') break;
    cursor = page.nextCursor;
  }
  return rows;
}

/** Every connection the caller can see that `filter` keeps. */
export async function listConnectionRows(
  client: KindgiClient,
  filter: ListConnectionsFilter,
): Promise<ConnectionRow[]> {
  const all = await everyPage((cursor) =>
    client.connections.list({ ...filter, ...(cursor !== undefined && { cursor }) }),
  );
  return all.map((c) => ({
    connectionId: c.connectionId,
    name: connectionName(c),
    app: c.app,
    account: c.account.label,
    whose: c.owner.kind === 'company' ? 'company' : (c.owner.userId ?? 'member'),
  }));
}

/**
 * Every company connection a choice in the project may name (at `app`). A
 * project member who isn't an admin gets only each one's id and name.
 */
export async function listCandidateRows(
  client: KindgiClient,
  projectId: string,
  app?: string,
): Promise<ConnectionRow[]> {
  const all = await everyPage((cursor) =>
    client.connectionChoices.candidates({
      projectId,
      ...(app !== undefined && { app }),
      ...(cursor !== undefined && { cursor }),
    }),
  );
  return all.map((c) => ({
    connectionId: c.connectionId,
    name: c.name,
    ...(c.app !== undefined && { app: c.app }),
    ...(c.accountLabel !== undefined && { account: c.accountLabel }),
    whose: 'company',
  }));
}

/** A name that matches none of the connections the caller can see: `kindgi connections list` shows them. */
export function connectionsListed(app: string | undefined): () => string {
  const flag = app !== undefined ? ` --app=${app}` : '';
  return () => `\`kindgi connections list${flag}\` shows them; pass a connection id instead.`;
}

/** A name that matches none of the project's candidates: they're named here, since no command lists them. */
export function candidatesListed(rows: readonly ConnectionRow[]): string {
  if (rows.length === 0) return 'This project has no company connection a choice can name.';
  return `This project's company connections: ${rows.map((r) => r.name).join(', ')}.`;
}

/**
 * A `connection-not-found` for the one connection id a command sent, said
 * with the flag that named it (`--connection`, `--reconnect`). The client
 * doesn't keep a 404's details, so a command that sends one id names its flag.
 */
export function namedBy(err: unknown, flag: string): unknown {
  const wire = extractKindgiError(err);
  if (wire?.code !== 'not-found' || wire.serverCode !== 'connection-not-found') return err;
  return new KindgiApiError({ ...wire, message: `--${flag}: ${wire.message}` });
}
