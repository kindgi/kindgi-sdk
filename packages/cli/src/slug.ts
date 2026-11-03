// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's slug, as the CLI makes and sends one: `kindgi projects create`
 * and `rename`, and the way `kindgi deploy` says how to make one; and a
 * workspace's, as `kindgi tenant rename` sends one.
 */

/**
 * The slugs the CLI sends: lowercase letters, digits and hyphens, starting
 * with a letter or digit, at most 63 characters. The server takes any slug
 * that isn't empty; the CLI keeps to these, which a shell and
 * `kindgi deploy --project <id|slug>` take as they are.
 */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A workspace's slug, as `kindgi tenant rename` sends one: the server's own
 * rule for a tenant's slug. Lowercase letters, digits and single hyphens,
 * starting and ending with a letter or digit, at most 63 characters.
 */
export const TENANT_SLUG = /^(?=.{1,63}$)[a-z0-9](?:-?[a-z0-9])*$/;

/**
 * A name as a slug: lowercase letters and digits, each run of anything else
 * one `-`, none at either end, at most 63 characters. An accent goes, not
 * its letter (`Café` is `cafe`).
 */
export function slugOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}
