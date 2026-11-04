// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** What a console short link can name. */
export type ConsolePageKind = 'runs' | 'agents' | 'flows' | 'schedules' | 'approvals';

/**
 * A link to one thing in the console: `<consoleUrl>/<kind>/<id>`, the
 * console's short link, which signs the person in and opens the thing's own
 * page (as `/approvals/<id>` in reviewer emails does). `undefined` when the
 * deployment set no console URL: the tools then leave `consoleUrl` out.
 */
export type ConsolePageLink = (kind: ConsolePageKind, id: string) => string | undefined;

export function consolePageLinks(consoleUrl: string | undefined): ConsolePageLink {
  if (consoleUrl === undefined) return () => undefined;
  const base = consoleUrl.replace(/\/+$/, '');
  return (kind, id) => `${base}/${kind}/${encodeURIComponent(id)}`;
}
