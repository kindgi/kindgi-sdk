// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AccountLookup, AppEntry, AppRemoval, SignIn } from './types.js';

/** An entry's `id`. */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** A key in an entry's `permissions`. */
export const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * A directory an `oauth2` sign-in's URLs name (`signIn.tenant`): its
 * `default`, and a registration's own. Microsoft's take a tenant id or
 * domain, `organizations`, `common` or `consumers`. It starts with a letter
 * or digit, so it can't be `.` or `..` in the URL's path.
 */
export const SIGN_IN_TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

const TENANT_PLACEHOLDER = '{tenant}';

const OWNER_KINDS: ReadonlySet<string> = new Set(['member', 'company']);
const REVIEW_CLASSES: ReadonlySet<string> = new Set(['none', 'sensitive', 'restricted']);
const REVOKE_KINDS: ReadonlySet<string> = new Set(['oauth2-revoke', 'github-installation-token']);
const NOTICE_KINDS: ReadonlySet<string> = new Set(['google-risc', 'github-webhooks']);

/**
 * Checks an app entry and returns a frozen copy of it. A field that's
 * wrong throws a `TypeError` naming it: an id or a permission key that
 * doesn't match its pattern, a URL that isn't `https:`, an owner, review
 * class, revoke or notice kind outside its set, a revoke or an account
 * lookup that doesn't fit the sign-in kind, a `{tenant}` in the sign-in's
 * URLs without a `signIn.tenant` (or with one, not once in each of the
 * authorize and token URLs, or more than once in the revoke URL), a
 * `{tenant}` in the profile lookup's URL, a rate limit that isn't a positive
 * whole number, a cost that isn't a whole number.
 */
export function defineApp(entry: AppEntry): AppEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw new TypeError('defineApp: the entry must be an object');
  }
  const at = (field: string): string => `defineApp(${JSON.stringify(entry.id)}): ${field}`;
  if (typeof entry.id !== 'string' || !APP_ID_PATTERN.test(entry.id)) {
    throw new TypeError(at(`id must match ${APP_ID_PATTERN.source}`));
  }
  requireText(entry.name, at('name'));
  requireText(entry.setupGuide, at('setupGuide'));
  if (!entry.setupGuide.startsWith('/')) {
    throw new TypeError(at('setupGuide must be a docs path starting with "/"'));
  }
  checkSignIn(entry.signIn, at);
  checkOwners(entry.owners, at);
  checkPermissions(entry.permissions, at);
  checkAccount(entry.account, entry.signIn, at);
  checkRemoval(entry.removal, entry.signIn, at);
  checkRateLimits(entry.rateLimits, at);
  return deepFreeze(structuredClone(entry));
}

type At = (field: string) => string;

function checkSignIn(signIn: SignIn, at: At): void {
  if (signIn?.kind === 'github-app') return;
  if (signIn?.kind !== 'oauth2') {
    throw new TypeError(at('signIn.kind must be "oauth2" or "github-app"'));
  }
  requireHttps(signIn.authorizeUrl, at('signIn.authorizeUrl'));
  requireHttps(signIn.tokenUrl, at('signIn.tokenUrl'));
  if (signIn.revokeUrl !== undefined) requireHttps(signIn.revokeUrl, at('signIn.revokeUrl'));
  if (signIn.pkce !== 'S256') throw new TypeError(at('signIn.pkce must be "S256"'));
  for (const [name, value] of Object.entries(signIn.authorizeParams ?? {})) {
    if (typeof value !== 'string') {
      throw new TypeError(at(`signIn.authorizeParams.${name} must be a string`));
    }
  }
  if (signIn.scopes !== undefined) requireTexts(signIn.scopes, at('signIn.scopes'));
  if (signIn.scopeResource !== undefined) {
    requireHttps(signIn.scopeResource, at('signIn.scopeResource'));
  }
  checkTenant(signIn, at);
}

/**
 * `{tenant}` is in the sign-in's URLs exactly when `signIn.tenant` fills
 * it: once in each of the authorize and token URLs, at most once in the
 * revoke URL.
 */
function checkTenant(signIn: Extract<SignIn, { kind: 'oauth2' }>, at: At): void {
  const urls = [
    ['authorizeUrl', signIn.authorizeUrl, 1],
    ['tokenUrl', signIn.tokenUrl, 1],
    ...(signIn.revokeUrl === undefined ? [] : [['revokeUrl', signIn.revokeUrl, 0] as const]),
  ] as const;
  if (signIn.tenant === undefined) {
    const holding = urls.find(([, url]) => url.includes(TENANT_PLACEHOLDER));
    if (holding !== undefined) {
      throw new TypeError(
        at(`signIn.${holding[0]} has ${TENANT_PLACEHOLDER}, so signIn.tenant is needed`),
      );
    }
    return;
  }
  if (typeof signIn.tenant !== 'object' || signIn.tenant === null) {
    throw new TypeError(at('signIn.tenant must be an object'));
  }
  const fallback: unknown = signIn.tenant.default;
  if (fallback !== undefined && !isTenant(fallback)) {
    throw new TypeError(at(`signIn.tenant.default must match ${SIGN_IN_TENANT_PATTERN.source}`));
  }
  for (const [name, url, least] of urls) {
    const count = url.split(TENANT_PLACEHOLDER).length - 1;
    if (count > 1 || count < least) {
      throw new TypeError(
        at(
          least === 1
            ? `signIn.${name} must hold ${TENANT_PLACEHOLDER} once, for signIn.tenant`
            : `signIn.${name} can hold ${TENANT_PLACEHOLDER} once at most`,
        ),
      );
    }
  }
}

function isTenant(value: unknown): boolean {
  return typeof value === 'string' && SIGN_IN_TENANT_PATTERN.test(value);
}

function checkOwners(owners: AppEntry['owners'], at: At): void {
  if (!Array.isArray(owners) || owners.length === 0) {
    throw new TypeError(at('owners must list at least one of "member", "company"'));
  }
  const seen = new Set<string>();
  for (const owner of owners) {
    if (!OWNER_KINDS.has(owner)) {
      throw new TypeError(at(`owners has ${JSON.stringify(owner)}; each is "member" or "company"`));
    }
    if (seen.has(owner)) throw new TypeError(at(`owners lists ${JSON.stringify(owner)} twice`));
    seen.add(owner);
  }
}

function checkPermissions(permissions: AppEntry['permissions'], at: At): void {
  const entries = Object.entries(permissions ?? {});
  if (entries.length === 0) throw new TypeError(at('permissions must have at least one'));
  for (const [key, permission] of entries) {
    const field = `permissions[${JSON.stringify(key)}]`;
    if (!PERMISSION_KEY_PATTERN.test(key)) {
      throw new TypeError(at(`${field}: the key must match ${PERMISSION_KEY_PATTERN.source}`));
    }
    requireText(permission?.grants, at(`${field}.grants`));
    requireText(permission.says, at(`${field}.says`));
    if (typeof permission.changes !== 'boolean') {
      throw new TypeError(at(`${field}.changes must be true or false`));
    }
    if (permission.review !== undefined && !REVIEW_CLASSES.has(permission.review)) {
      throw new TypeError(at(`${field}.review must be "none", "sensitive" or "restricted"`));
    }
  }
}

function checkAccount(account: AccountLookup, signIn: SignIn, at: At): void {
  if (account?.kind === 'github-installation') {
    if (signIn.kind !== 'github-app') {
      throw new TypeError(at('account.kind "github-installation" needs a "github-app" sign-in'));
    }
    return;
  }
  if (account?.kind === 'profile') {
    checkProfile(account, signIn, at);
    return;
  }
  if (account?.kind !== 'openid') {
    throw new TypeError(at('account.kind must be "openid", "github-installation" or "profile"'));
  }
  if (signIn.kind !== 'oauth2') {
    throw new TypeError(at('account.kind "openid" needs an "oauth2" sign-in'));
  }
  if (!Array.isArray(account.issuers) || account.issuers.length === 0) {
    throw new TypeError(at('account.issuers must list at least one issuer'));
  }
  requireHttps(account.issuers[0], at('account.issuers[0], the issuer keys are found at,'));
  account.issuers.forEach((issuer, i) => requireText(issuer, at(`account.issuers[${i}]`)));
  if (!Array.isArray(account.scopes) || !account.scopes.includes('openid')) {
    throw new TypeError(at('account.scopes must include "openid"'));
  }
  account.scopes.forEach((scope, i) => requireText(scope, at(`account.scopes[${i}]`)));
}

function checkProfile(
  account: Extract<AccountLookup, { kind: 'profile' }>,
  signIn: SignIn,
  at: At,
): void {
  if (signIn.kind !== 'oauth2') {
    throw new TypeError(at('account.kind "profile" needs an "oauth2" sign-in'));
  }
  requireHttps(account.url, at('account.url'));
  // The server fills the directory into the sign-in's URLs only.
  if (account.url.includes(TENANT_PLACEHOLDER)) {
    throw new TypeError(at(`account.url can't hold ${TENANT_PLACEHOLDER}`));
  }
  requireTexts(account.scopes, at('account.scopes'));
  requireText(account.id, at('account.id'));
  if (!Array.isArray(account.label) || account.label.length === 0) {
    throw new TypeError(at('account.label must name at least one field'));
  }
  account.label.forEach((field, i) => requireText(field, at(`account.label[${i}]`)));
}

function checkRemoval(removal: AppRemoval, signIn: SignIn, at: At): void {
  if (typeof removal !== 'object' || removal === null) {
    throw new TypeError(at('removal must be an object'));
  }
  if (removal.revoke !== undefined && !REVOKE_KINDS.has(removal.revoke)) {
    throw new TypeError(
      at('removal.revoke must be "oauth2-revoke" or "github-installation-token"'),
    );
  }
  if (
    removal.revoke === 'oauth2-revoke' &&
    (signIn.kind !== 'oauth2' || signIn.revokeUrl === undefined)
  ) {
    throw new TypeError(
      at('removal.revoke "oauth2-revoke" needs an "oauth2" sign-in with a revokeUrl'),
    );
  }
  if (removal.revoke === 'github-installation-token' && signIn.kind !== 'github-app') {
    throw new TypeError(
      at('removal.revoke "github-installation-token" needs a "github-app" sign-in'),
    );
  }
  if (removal.revokeIsGrantWide !== undefined && typeof removal.revokeIsGrantWide !== 'boolean') {
    throw new TypeError(at('removal.revokeIsGrantWide must be true or false'));
  }
  if (removal.notices !== undefined && !NOTICE_KINDS.has(removal.notices)) {
    throw new TypeError(at('removal.notices must be "google-risc" or "github-webhooks"'));
  }
}

function checkRateLimits(rateLimits: AppEntry['rateLimits'], at: At): void {
  (rateLimits ?? []).forEach((limit, i) => {
    const field = `rateLimits[${i}]`;
    if (limit?.per !== 'connection') throw new TypeError(at(`${field}.per must be "connection"`));
    requireCount(limit.units, at(`${field}.units`));
    requireCount(limit.perSeconds, at(`${field}.perSeconds`));
    for (const [tool, cost] of Object.entries(limit.costs ?? {})) {
      if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) {
        throw new TypeError(
          at(`${field}.costs[${JSON.stringify(tool)}] must be a whole number, 0 or more`),
        );
      }
    }
  });
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function requireTexts(values: unknown, field: string): void {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be a list of strings`);
  values.forEach((value, i) => requireText(value, `${field}[${i}]`));
}

function requireHttps(value: unknown, field: string): void {
  requireText(value, field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be an https URL`);
  }
  if (url.protocol !== 'https:') throw new TypeError(`${field} must be an https URL`);
}

function requireCount(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive whole number`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
