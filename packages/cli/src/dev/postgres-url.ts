// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Postgres URL split as the runtime splits one, never with `new URL`:
 * WHATWG's parser refuses a list of hosts with ports
 * (`postgres://me:pw@h1:5432,h2:5432/app`), which postgres.js takes, and
 * reads a list without ports as one host.
 */

/** `scheme://authority path ?query #fragment`, for postgres:// and postgresql://. */
const URL_PARTS = /^(postgres(?:ql)?:\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?(#.*)?$/i;

/** A database URL's parts, each as written. Joined back, they give the URL byte for byte. */
export interface PostgresUrlParts {
  /** `postgres://` or `postgresql://`. */
  readonly scheme: string;
  /** Up to and with the authority's last `@`, or `''` with none. */
  readonly credentials: string;
  /** The address's entries (`host` or `host:port`), split on `,`; `['']` for an empty address. */
  readonly hosts: readonly string[];
  /** The database: `/<name>`, or `''`. */
  readonly path: string;
  /** The query without its `?`; `undefined` with no `?`. */
  readonly query: string | undefined;
  /** With its `#`, or `''`. */
  readonly fragment: string;
}

/** The URL's parts, or `undefined` for one that isn't a postgres:// URL. Never throws. */
export function postgresUrlParts(url: string): PostgresUrlParts | undefined {
  const parts = URL_PARTS.exec(url);
  if (parts === null) return undefined;
  const [, scheme = '', authority = '', path = '', query, fragment = ''] = parts;
  const at = authority.lastIndexOf('@');
  return {
    scheme,
    credentials: authority.slice(0, at + 1),
    hosts: authority.slice(at + 1).split(','),
    path,
    query,
    fragment,
  };
}

/** The URL the parts make. */
export function joinPostgresUrl(parts: PostgresUrlParts): string {
  const query = parts.query === undefined ? '' : `?${parts.query}`;
  return `${parts.scheme}${parts.credentials}${parts.hosts.join(',')}${parts.path}${query}${parts.fragment}`;
}

/** An address entry's host (a bracketed IPv6 address keeps its brackets) and its port, if it has one. */
export function hostAndPort(entry: string): {
  readonly host: string;
  readonly port: string | undefined;
} {
  const bracketed = /^(\[[^\]]*\])(?::(.*))?$/.exec(entry);
  if (bracketed !== null) return { host: bracketed[1] ?? '', port: bracketed[2] };
  const colon = entry.indexOf(':');
  return colon === -1
    ? { host: entry, port: undefined }
    : { host: entry.slice(0, colon), port: entry.slice(colon + 1) };
}
