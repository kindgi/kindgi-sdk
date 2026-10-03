// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { ref, tuplesForCreate } from '@kindgi/authz';
import type { Scope, TenantHierarchyBinding } from '@kindgi/platform';
import type { Cursor, EnvName, TenantId } from '@kindgi/types';
import { makeEnvName } from '@kindgi/types';

import type { EnvBinding, EnvRecord } from '../env-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { SecretBinding, SecretRecord } from '../secrets-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * Tenant resource routes — part of the multi-tenant hierarchy. Config
 * reads and writes route through the two symmetric bindings
 * `EnvBinding` + `SecretBinding` at tenant scope.
 *
 * Three endpoints on `/v1/tenant` — the caller's tenant is always
 * implicit from the bearer token; there is no `/v1/tenants` collection
 * (tenants are the sovereignty boundary, not a listable resource under
 * a tenant).
 *
 *   - `GET   /`         — returns `{ id, name, slug, createdAt,
 *                         updatedAt }` for the caller's tenant.
 *                         Reads the tenant via the tenant-hierarchy
 *                         binding.
 *   - `GET   /config`   — cursor-paginated list of the tenant's config
 *                         entries: the env entries, then the secret
 *                         entries. Merged view over `EnvBinding.list` +
 *                         `SecretBinding.list` at `scope: tenant` with
 *                         `inherit: false` (tenant is the top of the
 *                         resolution walk — no upward inheritance is
 *                         possible). Optional `?kind=` filters to one
 *                         binding; `env` and `config` both surface the
 *                         env binding. Secret
 *                         `value` is ALWAYS redacted here (the admin
 *                         surface never returns raw plaintext).
 *   - `PATCH /config`   — upsert one config entry. Body: `{ kind, key,
 *                         value, sensitive?, ifRevision? }`. Routes to
 *                         `SecretBinding.set` when `kind === 'secret'`
 *                         OR `sensitive === true`; else to
 *                         `EnvBinding.set`. Returns 200 with `{ entry }`
 *                         on ok, 409 `tenant-config-revision-conflict`
 *                         when `ifRevision` mismatches.
 *
 * Env dimension. The wire shape doesn't carry `envName`, but both
 * bindings require it. The router
 * derives it from `KINDGI_ENV_NAME` at request time, falling back to
 * `'default'` if unset. Deployments that want per-env writes should use
 * the dedicated `/v1/env/*` + `/v1/secrets/*` routes.
 *
 * Mount policy. `/config` mounts when either `envBinding` OR
 * `secretsBinding` is present. If only one is wired, the other class of
 * writes returns 400 with a clear message.
 */
export interface TenantRouterOptions {
  readonly tenantHierarchyBinding: TenantHierarchyBinding;
  readonly envBinding?: EnvBinding;
  readonly secretsBinding?: SecretBinding;
  readonly authorizer?: Authorizer;
}

/**
 * Wire shape of one tenant config entry. Callers speak
 * `{ kind, key, value, sensitive?, revision, updatedAt }` and see the
 * same response envelope regardless of which binding actually stored
 * the write. `kind` collapses — `env` and `config` both
 * name the env binding; only `secret` names the secrets binding.
 */
type CompatConfigKind = 'env' | 'config' | 'secret';

interface CompatConfigEntry {
  readonly tenantId: TenantId;
  readonly kind: CompatConfigKind;
  readonly key: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly revision: number;
  readonly updatedAt: string;
}

/** The binding a `GET /config` page reads from: env entries first, then secrets. */
type ConfigSource = 'env' | 'secret';

/** Position in the merged list: a binding, and that binding's own cursor. */
interface ConfigCursor {
  readonly source: ConfigSource;
  readonly cursor?: string;
}

/**
 * Upper bound on binding `list` calls per `GET /config` request, so a
 * binding that keeps returning empty pages with a `nextCursor` can't
 * hold the request open; the response then carries the cursor on.
 */
const MAX_CONFIG_LIST_CALLS = 10;

/** Opaque url-safe base64 of the JSON position (as in `./pagination.ts`). */
function encodeConfigCursor(position: ConfigCursor): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/** Returns `null` on any decode failure — caller responds with 400 bad-input. */
function decodeConfigCursor(raw: string): ConfigCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const { source, cursor } = parsed as { source?: unknown; cursor?: unknown };
    if (source !== 'env' && source !== 'secret') return null;
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) return null;
    return cursor === undefined ? { source } : { source, cursor };
  } catch {
    return null;
  }
}

const DEFAULT_ENV_NAME: EnvName = ((): EnvName => {
  const raw = 'default';
  const validated = makeEnvName(raw);
  // Defensive: the constant grammar accepts 'default'; the null branch
  // is unreachable, but the cast is unavoidable without factory
  // widening.
  return validated ?? (raw as EnvName);
})();

function resolveTenantConfigEnvName(): EnvName {
  const raw = process.env.KINDGI_ENV_NAME;
  if (raw === undefined || raw.length === 0) return DEFAULT_ENV_NAME;
  const validated = makeEnvName(raw);
  return validated ?? DEFAULT_ENV_NAME;
}

export function tenantRouter(options: TenantRouterOptions): Hono<AppEnv> {
  const { tenantHierarchyBinding, envBinding, secretsBinding, authorizer } = options;
  const r = new Hono<AppEnv>();

  // Authorization — gate every /v1/tenant route with `read` on the
  // caller's tenant. Anyone with tenant admin/member cascades through
  // via can_read. Non-members (rare — usually implies a mis-issued
  // token) get 403 rather than the tenant metadata.
  if (authorizer !== undefined) {
    r.use(
      '*',
      authorizer.authorize('read', (c) => ref('tenant', c.get('tenantId') as unknown as string)),
    );
  }

  // ---------- GET / ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const row = await tenantHierarchyBinding.getTenant(tenantId);
    if (row === null) {
      c.status(statusFor('tenant-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'tenant-not-found',
            message: `No tenant with id "${tenantId as unknown as string}"`,
            tenantId: tenantId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json({
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  if (envBinding === undefined && secretsBinding === undefined) {
    return r;
  }

  // ---------- GET /config ----------
  r.get('/config', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const kindRaw = c.req.query('kind');
    let kindFilter: CompatConfigKind | undefined;
    if (kindRaw !== undefined && kindRaw.length > 0) {
      if (!isCompatConfigKind(kindRaw)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`kind` must be one of: env, config, secret' },
            requestId,
          ),
        );
      }
      kindFilter = kindRaw;
    }
    const keyPrefix = c.req.query('keyPrefix');
    const cursorRaw = c.req.query('cursor');
    const envName = resolveTenantConfigEnvName();
    const scope: Scope = { kind: 'tenant', tenantId };

    // Paging across two bindings with opaque cursors: the list is the
    // env entries (in the env binding's order) followed by the secret
    // entries (in the secrets binding's order). `env` and `config` both
    // draw from `envBinding`; `secret` from `secretsBinding`. The wire
    // cursor records which binding the next page starts in and that
    // binding's own cursor. Each binding page is requested with the
    // slots still free and taken whole, so a page never exceeds `limit`
    // and the binding's `nextCursor` is always an exact resume point.
    const wantsEnv = kindFilter === undefined || kindFilter === 'env' || kindFilter === 'config';
    const wantsSecret = kindFilter === undefined || kindFilter === 'secret';
    const sources: readonly ConfigSource[] = [
      ...(wantsEnv && envBinding !== undefined ? (['env'] as const) : []),
      ...(wantsSecret && secretsBinding !== undefined ? (['secret'] as const) : []),
    ];

    let position: ConfigCursor | null = sources[0] !== undefined ? { source: sources[0] } : null;
    if (cursorRaw !== undefined && cursorRaw.length > 0) {
      const decoded = decodeConfigCursor(cursorRaw);
      if (decoded === null || !sources.includes(decoded.source)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
        );
      }
      position = decoded;
    }

    const listFrom = async (
      at: ConfigCursor,
      pageLimit: number,
    ): Promise<{
      readonly entries: readonly CompatConfigEntry[];
      readonly nextCursor?: Cursor;
    }> => {
      const input = {
        scope,
        envName,
        limit: pageLimit,
        ...(keyPrefix !== undefined && keyPrefix.length > 0 && { namePrefix: keyPrefix }),
        ...(at.cursor !== undefined && { cursor: at.cursor as Cursor }),
      };
      if (at.source === 'env') {
        const page = await (envBinding as EnvBinding).list(input);
        return {
          entries: page.data.map((rec) => envRecordToCompat(rec, tenantId)),
          ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
        };
      }
      const page = await (secretsBinding as SecretBinding).list(input);
      return {
        entries: page.data.map((rec) => secretRecordToCompat(rec, tenantId)),
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
      };
    };
    const nextSource = (source: ConfigSource): ConfigCursor | null => {
      const following = sources[sources.indexOf(source) + 1];
      return following !== undefined ? { source: following } : null;
    };

    const entries: CompatConfigEntry[] = [];
    let calls = 0;
    while (position !== null && entries.length < limit && calls < MAX_CONFIG_LIST_CALLS) {
      calls += 1;
      const page = await listFrom(position, limit - entries.length);
      entries.push(...page.entries);
      position =
        page.nextCursor !== undefined
          ? { source: position.source, cursor: page.nextCursor }
          : nextSource(position.source);
    }
    // The page filled up exactly where a binding not yet read begins:
    // look ahead one entry so `hasMore` doesn't promise an empty page.
    while (position !== null && position.cursor === undefined && calls < MAX_CONFIG_LIST_CALLS) {
      calls += 1;
      const probe = await listFrom(position, 1);
      if (probe.entries.length > 0 || probe.nextCursor !== undefined) break;
      position = nextSource(position.source);
    }

    return c.json({
      data: entries,
      hasMore: position !== null,
      ...(position !== null && { nextCursor: encodeConfigCursor(position) }),
    });
  });

  // ---------- PATCH /config ----------
  r.patch('/config', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const b = body as Record<string, unknown>;
    if (!isCompatConfigKind(b.kind)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`kind` must be one of: env, config, secret' },
          requestId,
        ),
      );
    }
    if (typeof b.key !== 'string' || b.key.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`key` is required and must be a non-empty string' },
          requestId,
        ),
      );
    }
    if (typeof b.value !== 'string') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`value` is required and must be a string' },
          requestId,
        ),
      );
    }
    if (b.sensitive !== undefined && typeof b.sensitive !== 'boolean') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`sensitive` must be a boolean when present' },
          requestId,
        ),
      );
    }
    if (b.ifRevision !== undefined && typeof b.ifRevision !== 'number') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`ifRevision` must be a number when present' },
          requestId,
        ),
      );
    }

    const key = b.key;
    const value = b.value;
    const kind = b.kind;
    const explicitSensitive = b.sensitive as boolean | undefined;
    const ifRevision = b.ifRevision as number | undefined;
    const envName = resolveTenantConfigEnvName();
    const scope: Scope = { kind: 'tenant', tenantId };

    // `kind` collapse: `env` and `config` both name the env binding; a
    // caller flag of `sensitive: true` promotes the write to the
    // secrets binding regardless of `kind`. `kind: 'secret'` always
    // routes to secrets.
    const wantsSecrets = kind === 'secret' || explicitSensitive === true;

    if (wantsSecrets) {
      if (secretsBinding === undefined) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message:
                'A secret write was attempted but no `secretsBinding` is wired on this deployment.',
            },
            requestId,
          ),
        );
      }
      const currentRecord = await secretsBinding.get({ scope, envName, name: key });
      const writeMode = currentRecord === null ? 'create-new' : 'add-version';
      const outcome = await secretsBinding.set({
        scope,
        envName,
        name: key,
        value,
        writeMode,
        ...(ifRevision !== undefined && { ifVersion: ifRevision }),
        enqueueTuples: (secretRowId) =>
          tuplesForCreate({ kind: 'secret', id: secretRowId, tenantId, scope }),
      });
      if (outcome.kind === 'ok') {
        return c.json({
          entry: {
            tenantId: tenantId as unknown as string,
            kind: 'secret',
            key,
            value: '[redacted]',
            sensitive: true,
            revision: outcome.versionId,
            updatedAt: outcome.record.updatedAt,
          },
        });
      }
      if (outcome.kind === 'version-conflict') {
        c.status(statusFor('tenant-config-revision-conflict') as never);
        return c.json(
          toWireError(
            {
              code: 'tenant-config-revision-conflict',
              message: `Stored revision is ${outcome.currentVersion}; retry with the current value.`,
              currentRevision: outcome.currentVersion,
            },
            requestId,
          ),
        );
      }
      if (outcome.kind === 'already-exists') {
        return c.json({
          entry: {
            tenantId: tenantId as unknown as string,
            kind: 'secret',
            key,
            value: '[redacted]',
            sensitive: true,
            revision: outcome.record.currentVersion,
            updatedAt: outcome.record.updatedAt,
          },
        });
      }
      c.status(500);
      return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
    }

    if (envBinding === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: 'An env write was attempted but no `envBinding` is wired on this deployment.',
          },
          requestId,
        ),
      );
    }
    const outcome = await envBinding.set({
      scope,
      envName,
      name: key,
      value,
      ...(ifRevision !== undefined && { ifRevision }),
      enqueueTuples: (envRowId) => tuplesForCreate({ kind: 'env', id: envRowId, tenantId, scope }),
    });
    if (outcome.kind === 'ok') {
      // At this point `kind` is `env` or `config` (secrets branch
      // early-returned above); PATCH echoes the input verbatim so
      // callers see the same slot they wrote.
      return c.json({
        entry: {
          tenantId: tenantId as unknown as string,
          kind,
          key,
          value: outcome.record.value,
          sensitive: false,
          revision: outcome.record.revision,
          updatedAt: outcome.record.updatedAt,
        },
      });
    }
    if (outcome.kind === 'revision-conflict') {
      c.status(statusFor('tenant-config-revision-conflict') as never);
      return c.json(
        toWireError(
          {
            code: 'tenant-config-revision-conflict',
            message: `Stored revision is ${outcome.currentRevision}; retry with the current value.`,
            currentRevision: outcome.currentRevision,
          },
          requestId,
        ),
      );
    }
    c.status(500);
    return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
  });

  return r;
}

function isCompatConfigKind(x: unknown): x is CompatConfigKind {
  return x === 'env' || x === 'config' || x === 'secret';
}

function envRecordToCompat(rec: EnvRecord, tenantId: TenantId): CompatConfigEntry {
  return {
    tenantId,
    kind: 'env',
    key: rec.name,
    value: rec.value,
    sensitive: false,
    revision: rec.revision,
    updatedAt: rec.updatedAt,
  };
}

function secretRecordToCompat(rec: SecretRecord, tenantId: TenantId): CompatConfigEntry {
  return {
    tenantId,
    kind: 'secret',
    key: rec.name,
    // Admin surface never reveals the value. It is only accessible via
    // `SecretBinding.resolve` (dispatch path, capability-gated).
    value: '[redacted]',
    sensitive: true,
    revision: rec.currentVersion,
    updatedAt: rec.updatedAt,
  };
}
