// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Slugs: the rules the API checks an org's, a project's, a team's and a
 * workspace's slug against. The CLI and the console check the same ones
 * before they send a slug, so all three hold one copy.
 */

/** The longest slug an org, a project or a team takes. */
export const SLUG_MAX = 63;

/**
 * An org's, a project's or a team's slug: lowercase letters, digits and
 * hyphens, starting with a letter or digit, at most {@link SLUG_MAX}
 * characters. A shell and `kindgi deploy --project <id|slug>` take one as it is.
 */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** {@link SLUG}'s rule in words, as a refusal and the API reference say it. */
export const SLUG_RULE =
  'lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters';

/** The longest slug a workspace takes. */
export const TENANT_SLUG_MAX = 63;

/**
 * A workspace's slug: lowercase letters, digits and single hyphens, starting
 * and ending with a letter or digit, at most {@link TENANT_SLUG_MAX} characters.
 */
export const TENANT_SLUG = /^(?=.{1,63}$)[a-z0-9](?:-?[a-z0-9])*$/;

/** Whether `value` is an org's, a project's or a team's slug ({@link SLUG}). */
export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}

/** Whether `value` is a workspace's slug ({@link TENANT_SLUG}). */
export function isTenantSlug(value: unknown): value is string {
  return typeof value === 'string' && TENANT_SLUG.test(value);
}

/**
 * A name as a slug: lowercase letters and digits, each run of anything else
 * one `-`, none at either end, at most {@link SLUG_MAX} characters. An accent
 * goes, not its letter (`Café` is `cafe`). What it makes is a workspace's slug
 * too, or `''` when the name has no letter or digit.
 */
export function slugOf(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}
