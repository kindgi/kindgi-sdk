// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { Cursor, SigningKeyId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { SigningKeyBinding, TrustedKey } from '../signing-key-binding.js';
import type { AppEnv } from '../types.js';
import { capabilityRefusal } from './denied.js';
import { clampLimit } from './pagination.js';
import { tenantResourceAccess } from './tenant-access.js';

/**
 * The tenant's trusted signing keys: the public keys whose signatures
 * `POST /v1/deployments` accepts.
 *
 *   - `POST /v1/signing-keys`                  — trust a key.
 *   - `GET  /v1/signing-keys`                  — list (active; `includeRevoked=true` for all).
 *   - `GET  /v1/signing-keys/:keyId`           — one key, revoked or not.
 *   - `POST /v1/signing-keys/:keyId/revoke`    — stop trusting it.
 *
 * A revoked key stays readable, with `revokedAt` and its reason, so a
 * deployment it signed can still be audited; it no longer verifies new
 * deployments. Like an API token, a key is revoked, not unregistered.
 * Rotate by trusting a new `keyId`: a `keyId` is bound to its public key
 * for good.
 *
 * Writes need the `signing-keys:write` capability; reads, the tenant's
 * bearer.
 */
export function signingKeysRouter(
  binding: SigningKeyBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', tenantResourceAccess(authorizer));

  // ---------- POST / (trust a key) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const denied = requireWrite(c, authorizer);
    if (denied !== undefined) return denied;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    const parsed = parseAddBody(body);
    if (parsed.kind === 'err') {
      c.status(statusFor(parsed.error.code) as never);
      return c.json(toWireError(parsed.error, requestId));
    }

    const outcome = await binding.addTrusted({ tenantId, ...parsed.value });
    switch (outcome.kind) {
      case 'ok':
        c.status(201);
        return c.json(serializeKey(outcome.key));
      case 'already-trusted':
        return c.json(serializeKey(outcome.key));
      case 'key-id-conflict':
        c.status(statusFor('signing-key-conflict') as never);
        return c.json(
          toWireError(
            {
              code: 'signing-key-conflict',
              message: `Key id "${parsed.value.keyId as unknown as string}" is already trusted with a different public key. Trust the new key under a new key id.`,
            },
            requestId,
          ),
        );
      case 'error':
        c.status(statusFor(outcome.code) as never);
        return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
    }
  });

  // ---------- GET / (list) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const labelRaw = c.req.query('label');
    const page = await binding.listTrusted({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(c.req.query('includeRevoked') === 'true' && { includeRevoked: true }),
      ...(labelRaw !== undefined && labelRaw.length > 0 && { labelFilter: labelRaw }),
    });
    return c.json({
      data: page.data.map(serializeKey),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:keyId ----------
  r.get('/:keyId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const keyId = c.req.param('keyId') as SigningKeyId;
    const key = await binding.getTrusted({ tenantId, keyId });
    if (key === null) {
      c.status(statusFor('signing-key-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'signing-key-not-found',
            message: `No signing key "${keyId as unknown as string}" under this tenant`,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeKey(key));
  });

  // ---------- POST /:keyId/revoke ----------
  r.post('/:keyId/revoke', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const denied = requireWrite(c, authorizer);
    if (denied !== undefined) return denied;
    const keyId = c.req.param('keyId') as SigningKeyId;

    let reason: string | undefined;
    const text = await c.req.text();
    if (text.length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
        );
      }
      const raw = (body as { reason?: unknown } | null)?.reason;
      if (raw !== undefined && typeof raw !== 'string') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`reason` must be a string' }, requestId),
        );
      }
      reason = raw;
    }

    const outcome = await binding.revokeTrusted({
      tenantId,
      keyId,
      ...(reason !== undefined && { reason }),
    });
    return c.json({ keyId: keyId as unknown as string, revoked: outcome.revoked });
  });

  return r;
}

/** A 403 unless the bearer holds `signing-keys:write` (fail-closed), recorded. */
function requireWrite(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
): Response | undefined {
  return capabilityRefusal(
    c,
    authorizer,
    'signing-keys:write',
    'to change the trusted signing keys',
  );
}

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ED25519_PUBLIC_KEY_BYTES = 32;

function parseAddBody(body: unknown):
  | {
      readonly kind: 'ok';
      readonly value: {
        readonly keyId: SigningKeyId;
        readonly algorithm: string;
        readonly publicKey: string;
        readonly label?: string;
      };
    }
  | { readonly kind: 'err'; readonly error: { readonly code: string; readonly message: string } } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'err', error: { code: 'bad-input', message: 'Request body must be an object' } };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.keyId !== 'string' || !KEY_ID.test(b.keyId)) {
    return {
      kind: 'err',
      error: {
        code: 'bad-input',
        message:
          '`keyId` must be 1–128 characters: letters, digits, `.`, `_`, `:` or `-`, starting with a letter or digit',
      },
    };
  }
  const algorithm = b.algorithm ?? 'ed25519';
  if (algorithm !== 'ed25519') {
    return {
      kind: 'err',
      error: {
        code: 'signing-key-algorithm-unsupported',
        message: `\`algorithm\` must be "ed25519". Got ${JSON.stringify(algorithm)}.`,
      },
    };
  }
  if (typeof b.publicKey !== 'string' || !isBase64OfLength(b.publicKey, ED25519_PUBLIC_KEY_BYTES)) {
    return {
      kind: 'err',
      error: {
        code: 'bad-input',
        message: '`publicKey` must be base64 of the 32 raw bytes of an Ed25519 public key',
      },
    };
  }
  if (b.label !== undefined && (typeof b.label !== 'string' || b.label.length > 200)) {
    return {
      kind: 'err',
      error: { code: 'bad-input', message: '`label` must be a string of at most 200 characters' },
    };
  }
  return {
    kind: 'ok',
    value: {
      keyId: b.keyId as SigningKeyId,
      algorithm,
      publicKey: b.publicKey,
      ...(typeof b.label === 'string' && { label: b.label }),
    },
  };
}

function isBase64OfLength(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === bytes;
}

function serializeKey(key: TrustedKey): Record<string, unknown> {
  return {
    keyId: key.keyId as unknown as string,
    tenantId: key.tenantId as unknown as string,
    algorithm: key.algorithm,
    publicKey: key.publicKey,
    ...(key.label !== undefined && { label: key.label }),
    createdAt: key.createdAt,
    ...(key.revokedAt !== undefined && { revokedAt: key.revokedAt }),
    ...(key.revokedReason !== undefined && { revokedReason: key.revokedReason }),
  };
}
