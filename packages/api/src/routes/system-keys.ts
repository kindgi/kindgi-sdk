// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import { requireFullSystem } from '../middleware/system.js';
import { FULL_SYSTEM_CAPABILITY, type SystemScope, isSystemScope } from '../system.js';
import type { AppEnv } from '../types.js';
import { parseTimeInput } from './time-input.js';
import { refuseMalformedUuidParam } from './uuid-param.js';

/** A system key, as stored: never its secret. */
export interface SystemKeyRecord {
  /** A UUID. */
  readonly id: string;
  readonly label?: string;
  /** Its system scopes, or `kindgi:system` for all of them. */
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
  /** Who minted it: a system key's id, or `boot` for the deployment's own token. */
  readonly mintedBy: string;
}

export interface SystemKeyMintInput {
  readonly scopes: readonly string[];
  readonly label?: string;
  readonly expiresAt?: Date;
  readonly mintedBy: string;
}

/**
 * Where the runtime keeps system keys (`kgi_sy_…`): outside every tenant,
 * hashed. The secret is returned by `mint` only.
 */
export interface SystemKeysBinding {
  mint(
    input: SystemKeyMintInput,
  ): Promise<{ readonly record: SystemKeyRecord; readonly token: string }>;
  /** Every system key, newest first, revoked ones too. */
  list(): Promise<readonly SystemKeyRecord[]>;
  /**
   * Revokes the key **and every key minted from it**, along `mintedBy`
   * (`systemKeysMintedFrom`), in one change: a leaked key's children stop
   * with it. `null` when there's no key with that id. Revoking twice keeps
   * the first time.
   */
  revoke(id: string): Promise<{
    readonly key: SystemKeyRecord;
    /** The ids revoked with it, because they were minted from it. */
    readonly alsoRevoked: readonly string[];
  } | null>;
}

/**
 * The keys minted from `id`, however deep, along `mintedBy`: what revoking
 * `id` revokes too. For a binding's `revoke`; a cycle (which minting never
 * makes) ends the walk.
 */
export function systemKeysMintedFrom(
  keys: readonly Pick<SystemKeyRecord, 'id' | 'mintedBy'>[],
  id: string,
): readonly string[] {
  const children = new Map<string, string[]>();
  for (const key of keys) {
    const siblings = children.get(key.mintedBy) ?? [];
    siblings.push(key.id);
    children.set(key.mintedBy, siblings);
  }
  const found: string[] = [];
  const seen = new Set<string>([id]);
  const queue = [...(children.get(id) ?? [])];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) continue;
    seen.add(next);
    found.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}

const MAX_LABEL_LENGTH = 100;

type WireError = { readonly code: string; readonly message: string } & Readonly<
  Record<string, unknown>
>;

/**
 * `/v1/system/keys`: the operator's keys, for the services that act for it
 * (sign-up, the orchestrator, billing, the license renewal), each with the
 * least scope it needs. Only the full system capability (`kindgi:system`:
 * the deployment's own token, or a full system key) mints, lists or revokes
 * them; a scoped key never mints any key. On a runtime serving one tenant
 * only the deployment's own token reaches them, and they mint the scopes
 * `options.mintable` names alone (`system:license`, for the license
 * renewal, and, with a pack service per deployment, its orchestrator's).
 */
export function systemKeysRouter(
  binding: SystemKeysBinding,
  authorizer?: Authorizer,
  options: {
    /** The scopes a key may be minted with; absent, every system scope and `kindgi:system`. */
    readonly mintable?: readonly SystemScope[];
  } = {},
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('/*', requireFullSystem(authorizer));

  // ---------- POST / (mint) ----------
  r.post('/', async (c) => {
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parseMintBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    const unservedScope = unserved(parsed.value.scopes, options.mintable);
    if (unservedScope !== undefined) return fail(c, unservedScope);
    const refused =
      expiryRefusal(c, parsed.value.expiresAt) ?? fullKeyExpiryRefusal(c, parsed.value);
    if (refused !== undefined) return fail(c, refused);
    const minted = await binding.mint({
      ...parsed.value,
      mintedBy: c.get('systemPrincipal')?.keyId ?? 'boot',
    });
    // The secret is shown once: an Idempotency-Key repeat doesn't get it.
    withholdFromReplay(c);
    c.status(201);
    return c.json({ ...toWire(minted.record), token: minted.token });
  });

  // ---------- GET / (list; never secrets) ----------
  r.get('/', async (c) => c.json({ data: (await binding.list()).map(toWire) }));

  // ---------- POST /:keyId/revoke ----------
  r.post('/:keyId/revoke', refuseMalformedUuidParam('keyId', 'a system key id'), async (c) => {
    const keyId = c.req.param('keyId');
    const revoked = await binding.revoke(keyId);
    if (revoked === null) {
      return fail(c, {
        code: 'system-key-not-found',
        message: `No system key with id "${keyId}".`,
      });
    }
    return c.json({ ...toWire(revoked.key), alsoRevoked: revoked.alsoRevoked });
  });

  return r;
}

/**
 * A key can't outlive the key minting it: a later or absent `expiresAt` is
 * refused when the minter expires (`403 token-expiry-exceeds-minter`), as
 * for a tenant's keys. The deployment's own token has no expiry.
 */
function expiryRefusal(c: Context<AppEnv>, expiresAt: Date | undefined): WireError | undefined {
  const minterExpires = c.get('tokenExpiresAt');
  if (minterExpires === undefined) return undefined;
  if (expiresAt !== undefined && expiresAt.getTime() <= minterExpires.getTime()) return undefined;
  const latest = minterExpires.toISOString();
  return {
    code: 'token-expiry-exceeds-minter',
    message: `A system key can't outlive the key minting it: set expiresAt no later than ${latest}`,
    latestExpiresAt: latest,
  };
}

/**
 * A full key (`kindgi:system`) minted by another system key must expire:
 * only the deployment's own token mints one that never does, so a chain of
 * full keys always ends (`403 system-key-expiry-required`).
 */
function fullKeyExpiryRefusal(c: Context<AppEnv>, body: ParsedMintBody): WireError | undefined {
  const minter = c.get('systemPrincipal')?.keyId ?? 'boot';
  if (minter === 'boot' || body.expiresAt !== undefined) return undefined;
  if (!body.scopes.includes(FULL_SYSTEM_CAPABILITY)) return undefined;
  return {
    code: 'system-key-expiry-required',
    message:
      "A full system key minted by another system key must expire: set expiresAt. Only the deployment's own token mints one that never does.",
  };
}

function toWire(record: SystemKeyRecord) {
  return {
    id: record.id,
    ...(record.label !== undefined && { label: record.label }),
    scopes: record.scopes,
    createdAt: record.createdAt.toISOString(),
    ...(record.expiresAt !== undefined && { expiresAt: record.expiresAt.toISOString() }),
    ...(record.revokedAt !== undefined && { revokedAt: record.revokedAt.toISOString() }),
    mintedBy: record.mintedBy,
  };
}

type Parsed<T> = { kind: 'ok'; value: T } | { kind: 'err'; error: WireError };

interface ParsedMintBody {
  readonly scopes: readonly string[];
  readonly label?: string;
  readonly expiresAt?: Date;
}

function parseMintBody(body: unknown): Parsed<ParsedMintBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  const scopes = parseScopes(b.scopes);
  if (scopes.kind === 'err') return scopes;
  const label = parseLabel(b.label);
  if (label.kind === 'err') return label;
  const expiresAt = parseExpiry(b.expiresAt);
  if (expiresAt.kind === 'err') return expiresAt;
  return {
    kind: 'ok',
    value: {
      scopes: scopes.value,
      ...(label.value !== undefined && { label: label.value }),
      ...(expiresAt.value !== undefined && { expiresAt: expiresAt.value }),
    },
  };
}

/** A mint asking for a scope this runtime doesn't mint keys with, if it does. */
function unserved(
  scopes: readonly string[],
  mintable: readonly SystemScope[] | undefined,
): WireError | undefined {
  if (mintable === undefined) return undefined;
  const other = scopes.filter((scope) => !mintable.includes(scope as SystemScope));
  if (other.length === 0) return undefined;
  return badInput(
    `\`scopes\`: this runtime serves one tenant, where a system key holds ${mintable.join(', ')} alone, not ${other.join(', ')}`,
  ).error;
}

/** `scopes`: distinct system scopes, or `kindgi:system` alone. */
function parseScopes(raw: unknown): Parsed<readonly string[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return badInput('`scopes` must name at least one system scope, or `kindgi:system`');
  }
  const scopes: string[] = [];
  for (const scope of raw) {
    if (typeof scope !== 'string' || !(scope === FULL_SYSTEM_CAPABILITY || isSystemScope(scope))) {
      return badInput(`\`scopes\`: ${JSON.stringify(scope)} isn't a system scope`);
    }
    if (scopes.includes(scope)) return badInput(`\`scopes\`: ${scope} is named twice`);
    scopes.push(scope);
  }
  if (scopes.includes(FULL_SYSTEM_CAPABILITY) && scopes.length > 1) {
    return badInput(`\`scopes\`: ${FULL_SYSTEM_CAPABILITY} holds every scope; name it alone`);
  }
  return { kind: 'ok', value: scopes };
}

function parseLabel(raw: unknown): Parsed<string | undefined> {
  if (raw === undefined) return { kind: 'ok', value: undefined };
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_LABEL_LENGTH) {
    return badInput(
      `\`label\` must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`,
    );
  }
  return { kind: 'ok', value: raw };
}

function parseExpiry(raw: unknown): Parsed<Date | undefined> {
  if (raw === undefined) return { kind: 'ok', value: undefined };
  const at = parseTimeInput(raw);
  if (at === null) return badInput('`expiresAt` must be an ISO-8601 time');
  if (at.getTime() <= Date.now()) return badInput('`expiresAt` must be in the future');
  return { kind: 'ok', value: at };
}

async function readJsonBody(c: Context<AppEnv>): Promise<Parsed<unknown>> {
  try {
    return { kind: 'ok', value: JSON.parse(await c.req.text()) as unknown };
  } catch {
    return badInput('Request body must be JSON');
  }
}

function badInput(message: string): { kind: 'err'; error: WireError } {
  return { kind: 'err', error: { code: 'bad-input', message } };
}

function fail(c: Context<AppEnv>, error: WireError): Response {
  c.status(statusFor(error.code) as never);
  // `toWireError` puts every field besides code and message under `details`.
  return c.json(toWireError(error, c.get('requestId')));
}
