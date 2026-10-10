// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { tuplesForCreate } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { RotationStatus, RotationStatusStore } from '../rotation-status-store.js';
import type {
  SecretBinding,
  SecretRecord,
  SecretSetOutcome,
  SecretVersionRecord,
} from '../secrets-binding.js';
import type { AppEnv } from '../types.js';
import { capabilityRefusal } from './denied.js';
import { requireEnvName, requireScope, scopesEqual } from './env.js';
import { clampLimit } from './pagination.js';
import { queryScopeResourceRef, scopeResourceRef } from './scope-params.js';

/**
 * `/v1/secrets/*` — HTTP surface for `SecretBinding`. Nine endpoints
 * covering the full
 * lifecycle: list / get / set / rotate (sync + async) / rotation-status
 * poll / rotation-status SSE / revoke / version list / version get.
 *
 * Wire-safety:
 *   - `value` NEVER returns from list / get / getVersion / listVersions.
 *   - Within `/v1/secrets`, plaintext is accepted only by `POST /`
 *     (`value`, `secrets:write` capability) and `POST /:name/rotate`
 *     (optional `newValue`, `secrets:rotate` capability).
 *   - Async rotation returns 202 with `{ rotationId, statusUrl,
 *     eventsUrl }`; sync rotation returns 201 with the outcome inline.
 *
 * Capability gates:
 *   - `secrets:write`   → POST /
 *   - `secrets:rotate`  → POST /:name/rotate
 *   - `secrets:revoke`  → DELETE /:name (soft)
 *   - `secrets:revoke:hard` → DELETE /:name?hard=true
 *   - `secrets:reveal`  → not used by these routes; there is no HTTP
 *     `resolve` path.
 *
 * SSE:
 *   - `GET /:name/rotations/:rotationId/events` streams
 *     `event: rotation-update\ndata: <json>\n\n` frames on each status
 *     change. An `event: ping` heartbeat (empty data) every 15s keeps
 *     proxies from timing the stream out; the stream closes on terminal
 *     state.
 */
export interface SecretsRouterOptions {
  readonly secretsBinding: SecretBinding;
  readonly rotationStatusStore: RotationStatusStore;
  /**
   * Overrideable SSE heartbeat interval. Default 15_000 ms; tests
   * pass a low value to keep suites fast.
   */
  readonly sseHeartbeatMs?: number;
  /**
   * Optional fine-grained authorizer. When present, gates every route
   * on `admin` on the request's `scope` (query for GET/DELETE, body for
   * create, body or query for rotate). Reads are STRICT: strict-read means `admin from scope`
   * or explicit `reader` grant — cascade via the scope tuple written
   * by `secretsBinding.set` on fresh create.
   */
  readonly authorizer?: Authorizer;
}

export function secretsRouter(options: SecretsRouterOptions): Hono<AppEnv> {
  const { secretsBinding, rotationStatusStore, authorizer } = options;
  const heartbeatMs = options.sseHeartbeatMs ?? 15_000;
  const r = new Hono<AppEnv>();

  // Authorization PEP — scope-anchored.
  // STRICT-READ: only scope-admins or explicit `reader` grantees pass
  // `can_read` on a secret. Each check derives the scope with the same
  // parser as its handler: `POST /` from `body.scope`; `POST /:name/rotate`
  // from `body.scope` or the query (resolveRotateScope); every other route
  // from `?scopeKind` + `?scopeId`.
  if (authorizer !== undefined) {
    const scopeFromQuery = (c: import('hono').Context<AppEnv>) =>
      queryScopeResourceRef((n) => c.req.query(n), { tenantId: c.get('tenantId') as TenantId });
    r.use('/', async (c, next) => {
      if (c.req.method === 'POST') {
        const tenantId = c.get('tenantId') as TenantId;
        const mw = authorizer.authorize('admin', async () => {
          let bodyScope: unknown;
          try {
            const body = await c.req.json();
            if (body !== null && typeof body === 'object') {
              bodyScope = (body as Record<string, unknown>).scope;
            }
          } catch {
            // POST handler validates + returns 400
          }
          const s = validateBodyScope(bodyScope, tenantId);
          return scopeResourceRef(s.kind === 'ok' ? s.scope : undefined, tenantId);
        });
        return mw(c, next);
      }
      if (c.req.method === 'GET') {
        const mw = authorizer.authorize('admin', scopeFromQuery);
        return mw(c, next);
      }
      return next();
    });
    // `/:name/*` also matches `/:name`: one check per request. The only
    // POST below `/:name` is rotate, which may carry its scope in the body;
    // read it with `text()`, as the handler does.
    r.use('/:name/*', async (c, next) => {
      if (c.req.method === 'POST') {
        const tenantId = c.get('tenantId') as TenantId;
        const mw = authorizer.authorize('admin', async () => {
          const s = resolveRotateScope(
            parseJsonObject(await c.req.text()),
            c.req.query(),
            tenantId,
          );
          return scopeResourceRef(s.kind === 'ok' ? s.scope : undefined, tenantId);
        });
        return mw(c, next);
      }
      const mw = authorizer.authorize('admin', scopeFromQuery);
      return mw(c, next);
    });
  }

  // ------------------------------ GET / ------------------------------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const namePrefix = c.req.query('namePrefix');

    const page = await secretsBinding.list({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(namePrefix !== undefined && namePrefix.length > 0 && { namePrefix }),
    });
    return c.json({
      data: page.data.map(serializeSecretRecord),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------------------- GET /:name -----------------------------
  r.get('/:name', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const rec = await secretsBinding.get({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      name,
    });
    if (rec === null) {
      c.status(statusFor('secret-not-found') as never);
      return c.json(
        toWireError({ code: 'secret-not-found', message: `No secret "${name}".`, name }, requestId),
      );
    }
    return c.json(serializeSecretRecord(rec));
  });

  // ------------------ GET /:name/versions -----------------------
  r.get('/:name/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');

    const page = await secretsBinding.listVersions({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      name,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
    });
    return c.json({
      data: page.data.map(serializeVersion),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // -------------- GET /:name/versions/:versionId -----------------
  r.get('/:name/versions/:versionId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');
    const versionIdRaw = c.req.param('versionId');
    const versionId = Number.parseInt(versionIdRaw, 10);
    if (!Number.isFinite(versionId) || versionId < 1) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`versionId` must be a positive integer.' },
          requestId,
        ),
      );
    }

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const rec = await secretsBinding.getVersion({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      name,
      versionId,
    });
    if (rec === null) {
      c.status(statusFor('secret-version-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'secret-version-not-found',
            message: `No version ${versionId} for secret "${name}".`,
            name,
            versionId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeVersion(rec));
  });

  // ------------------------- POST / -----------------------------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const missing = capabilityRefusal(c, authorizer, 'secrets:write');
    if (missing !== undefined) return missing;

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

    // Body-first envName + scope validation — POST /v1/secrets carries
    // both entirely in the body (no path params to steer them). Query
    // params are optional here.
    const envNameRaw = (b.envName as string | undefined) ?? c.req.query('envName');
    const envNameResult = requireEnvName(envNameRaw);
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const bodyScope = validateBodyScope(b.scope, tenantId);
    if (bodyScope.kind === 'err') {
      c.status(statusFor(bodyScope.code) as never);
      return c.json(toWireError({ code: bodyScope.code, message: bodyScope.message }, requestId));
    }

    if (typeof b.name !== 'string' || b.name.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`name` is required and must be a non-empty string' },
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
    if (b.writeMode !== 'create-new' && b.writeMode !== 'add-version') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: '`writeMode` must be one of `create-new` | `add-version`',
          },
          requestId,
        ),
      );
    }
    if (b.ifVersion !== undefined && typeof b.ifVersion !== 'number') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`ifVersion` must be a number when present' },
          requestId,
        ),
      );
    }
    if (b.rotationDueAt !== undefined && typeof b.rotationDueAt !== 'string') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`rotationDueAt` must be an ISO 8601 string when present' },
          requestId,
        ),
      );
    }
    if (
      b.tags !== undefined &&
      (b.tags === null || typeof b.tags !== 'object' || Array.isArray(b.tags))
    ) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`tags` must be a string map when present' },
          requestId,
        ),
      );
    }

    const setScope = bodyScope.scope;
    const outcome: SecretSetOutcome = await secretsBinding.set({
      scope: setScope,
      envName: envNameResult.envName,
      name: b.name,
      value: b.value,
      writeMode: b.writeMode,
      ...(b.tags !== undefined && { tags: b.tags as Readonly<Record<string, string>> }),
      ...(b.rotationDueAt !== undefined && { rotationDueAt: b.rotationDueAt as string }),
      ...(b.ifVersion !== undefined && { ifVersion: b.ifVersion as number }),
      // Authorization — write `secret#scope@X` tuple on fresh insert.
      enqueueTuples: (secretRowId) =>
        tuplesForCreate({ kind: 'secret', id: secretRowId, tenantId, scope: setScope }),
    });

    if (outcome.kind === 'ok') {
      // Freshly-created secrets return 201 (`create-new` path); every
      // subsequent version of an existing secret returns 200 (`add-version`).
      const status = b.writeMode === 'create-new' ? 201 : 200;
      c.status(status as never);
      return c.json({
        record: serializeSecretRecord(outcome.record),
        versionId: outcome.versionId,
      });
    }
    if (outcome.kind === 'already-exists') {
      c.status(statusFor('secret-write-conflict') as never);
      return c.json(
        toWireError(
          {
            code: 'secret-write-conflict',
            message: `Secret "${outcome.record.name}" already exists. Use writeMode: 'add-version' to add a new version.`,
            currentVersion: outcome.record.currentVersion,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'version-conflict') {
      c.status(statusFor('secret-write-conflict') as never);
      return c.json(
        toWireError(
          {
            code: 'secret-write-conflict',
            message: `Stored version is ${outcome.currentVersion}; retry with the current value.`,
            currentVersion: outcome.currentVersion,
          },
          requestId,
        ),
      );
    }
    // error case
    c.status(statusFor(outcome.code) as never);
    return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
  });

  // -------------------- POST /:name/rotate -----------------------
  r.post('/:name/rotate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');

    const missing = capabilityRefusal(c, authorizer, 'secrets:rotate');
    if (missing !== undefined) return missing;

    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
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
    }
    const b = body as Record<string, unknown>;

    const queryEnvName = c.req.query('envName');
    if (b.envName !== undefined && queryEnvName !== undefined && b.envName !== queryEnvName) {
      c.status(statusFor('env-name-mismatch') as never);
      return c.json(
        toWireError(
          {
            code: 'env-name-mismatch',
            message: `Body \`envName\` "${String(b.envName)}" does not match query envName "${queryEnvName}".`,
          },
          requestId,
        ),
      );
    }
    const envNameRaw = (b.envName as string | undefined) ?? queryEnvName;
    const envNameResult = requireEnvName(envNameRaw);
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    // The same resolution the authorization middleware checked.
    const scopeResult = resolveRotateScope(b, c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }
    const scope: Scope = scopeResult.scope;

    if (b.newValue !== undefined && typeof b.newValue !== 'string') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`newValue` must be a string when present' },
          requestId,
        ),
      );
    }
    if (b.revokeOldAfterMs !== undefined && typeof b.revokeOldAfterMs !== 'number') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`revokeOldAfterMs` must be a number when present' },
          requestId,
        ),
      );
    }

    const result = await secretsBinding.rotate({
      scope,
      envName: envNameResult.envName,
      name,
      ...(b.newValue !== undefined && { newValue: b.newValue as string }),
      ...(b.revokeOldAfterMs !== undefined && { revokeOldAfterMs: b.revokeOldAfterMs as number }),
    });

    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError({ code: result.error.code, message: result.error.message, name }, requestId),
      );
    }

    if (result.value.kind === 'ok') {
      // Sync provider — 201 Created inline.
      c.status(201 as never);
      return c.json({
        kind: 'sync',
        newVersionId: result.value.newVersionId,
        oldVersionId: result.value.oldVersionId,
        ...(result.value.oldVersionRevokedAt !== undefined && {
          oldVersionRevokedAt: result.value.oldVersionRevokedAt,
        }),
      });
    }

    // Async provider — mint a rotationId, record, return 202.
    const { rotationId } = await rotationStatusStore.create({
      scope,
      envName: envNameResult.envName,
      name,
      provider: result.value.provider,
      resumeToken: result.value.resumeToken,
    });
    const query = encodeStatusQuery(scope, envNameResult.envName);
    const statusUrl = `/v1/secrets/${encodeURIComponent(name)}/rotations/${rotationId}?${query}`;
    const eventsUrl = `/v1/secrets/${encodeURIComponent(name)}/rotations/${rotationId}/events?${query}`;
    c.status(202 as never);
    return c.json({ kind: 'async', rotationId, statusUrl, eventsUrl });
  });

  // -------- GET /:name/rotations/:rotationId ----------
  r.get('/:name/rotations/:rotationId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');
    const rotationId = c.req.param('rotationId');

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const status = await rotationStatusStore.get({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      name,
      rotationId,
    });
    if (status === null) {
      c.status(statusFor('not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'not-found',
            message: `No rotation "${rotationId}" for secret "${name}".`,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeRotationStatus(status));
  });

  // -- GET /:name/rotations/:rotationId/events (SSE) --
  r.get('/:name/rotations/:rotationId/events', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');
    const rotationId = c.req.param('rotationId');

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const existing = await rotationStatusStore.get({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      name,
      rotationId,
    });
    if (existing === null) {
      c.status(statusFor('not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'not-found',
            message: `No rotation "${rotationId}" for secret "${name}".`,
          },
          requestId,
        ),
      );
    }

    const encoder = new TextEncoder();
    const initialStatus = existing;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        const emit = (event: string, data: unknown): void => {
          if (closed) return;
          const payload = event === 'ping' ? '' : JSON.stringify(data);
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
          } catch {
            /* already closed */
          }
        };

        // Emit the initial state so a subscriber that connects after
        // the first update still learns where the rotation stands.
        emit('rotation-update', initialStatus);

        if (initialStatus.status !== 'pending') {
          close();
          return;
        }

        let terminal = false;
        let notifier: (() => void) | undefined;
        const wakeup = (): void => {
          if (notifier !== undefined) {
            const cb = notifier;
            notifier = undefined;
            cb();
          }
        };

        const unsub = rotationStatusStore.subscribe({
          rotationId,
          onUpdate: (s) => {
            emit('rotation-update', s);
            if (s.status !== 'pending') {
              terminal = true;
            }
            wakeup();
          },
        });

        const timer = setInterval(() => {
          if (terminal) return;
          emit('ping', {});
        }, heartbeatMs);

        try {
          while (!terminal) {
            await new Promise<void>((resolve) => {
              notifier = resolve;
            });
          }
        } finally {
          clearInterval(timer);
          unsub();
          close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
    });
  });

  // ------------------------ DELETE /:name -----------------------
  r.delete('/:name', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const name = c.req.param('name');
    const hardFlag = c.req.query('hard') === 'true';

    const requiredCap = hardFlag ? 'secrets:revoke:hard' : 'secrets:revoke';
    const missing = capabilityRefusal(c, authorizer, requiredCap);
    if (missing !== undefined) return missing;

    const envNameResult = requireEnvName(c.req.query('envName'));
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const scopeResult = requireScope(c.req.query(), tenantId);
    if (scopeResult.kind === 'err') {
      c.status(statusFor(scopeResult.code) as never);
      return c.json(
        toWireError({ code: scopeResult.code, message: scopeResult.message }, requestId),
      );
    }

    const reason = c.req.query('reason');
    const outcome = await secretsBinding.revoke({
      scope: scopeResult.scope,
      envName: envNameResult.envName,
      name,
      ...(hardFlag && { hard: true }),
      ...(reason !== undefined && reason.length > 0 && { reason }),
    });

    if (outcome.kind === 'err') {
      c.status(statusFor(outcome.error.code) as never);
      return c.json(
        toWireError({ code: outcome.error.code, message: outcome.error.message, name }, requestId),
      );
    }
    return c.json({ revoked: outcome.value.revoked, hard: outcome.value.hard });
  });

  return r;
}

// --------------------------- helpers ---------------------------

function encodeStatusQuery(scope: Scope, envName: EnvName): string {
  const params = new URLSearchParams();
  params.set('envName', envName as unknown as string);
  params.set('scopeKind', scope.kind);
  if (scope.kind === 'org') {
    params.set('scopeId', scope.orgId as unknown as string);
  } else if (scope.kind === 'project') {
    params.set('scopeId', scope.projectId as unknown as string);
  }
  return params.toString();
}

type BodyScopeResult =
  | { readonly kind: 'ok'; readonly scope: Scope }
  | { readonly kind: 'err'; readonly code: string; readonly message: string };

function validateBodyScope(raw: unknown, tenantId: TenantId): BodyScopeResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'err',
      code: 'scope-kind-required',
      message: '`scope` is required in the request body.',
    };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== 'tenant' && obj.kind !== 'org' && obj.kind !== 'project') {
    return {
      kind: 'err',
      code: 'scope-kind-required',
      message: '`scope.kind` must be one of `tenant` | `org` | `project`.',
    };
  }
  // Cross-tenant refuse: body `tenantId` must match session tenantId.
  if (obj.tenantId !== undefined && obj.tenantId !== (tenantId as unknown as string)) {
    return {
      kind: 'err',
      code: 'scope-mismatch',
      message: 'Body `scope.tenantId` does not match session tenantId.',
    };
  }
  if (obj.kind === 'tenant') {
    return {
      kind: 'ok',
      scope: { kind: 'tenant', tenantId } as Scope,
    };
  }
  if (obj.kind === 'org') {
    if (typeof obj.orgId !== 'string' || obj.orgId.length === 0) {
      return {
        kind: 'err',
        code: 'scope-invalid',
        message: '`scope.orgId` is required when scope.kind is `org`.',
      };
    }
    return {
      kind: 'ok',
      scope: { kind: 'org', tenantId, orgId: obj.orgId } as Scope,
    };
  }
  if (typeof obj.projectId !== 'string' || obj.projectId.length === 0) {
    return {
      kind: 'err',
      code: 'scope-invalid',
      message: '`scope.projectId` is required when scope.kind is `project`.',
    };
  }
  return {
    kind: 'ok',
    scope: { kind: 'project', tenantId, projectId: obj.projectId } as Scope,
  };
}

/**
 * The scope `POST /:name/rotate` acts on: `body.scope` when present, else
 * the `?scopeKind` + `?scopeId` query parameters. When the body and the
 * query both carry a scope they must name the same one (`scope-mismatch`).
 * The authorization middleware and the handler both resolve through here.
 */
function resolveRotateScope(
  body: Record<string, unknown>,
  query: Record<string, string>,
  tenantId: TenantId,
): BodyScopeResult {
  const queryHasScope = query.scopeKind !== undefined || query.scopeId !== undefined;
  const queryScope = requireScope(query, tenantId);
  if (body.scope === undefined) return queryScope;
  const bodyScope = validateBodyScope(body.scope, tenantId);
  if (bodyScope.kind === 'err' || !queryHasScope) return bodyScope;
  if (queryScope.kind === 'err') return queryScope;
  if (!scopesEqual(body.scope, queryScope.scope)) {
    return {
      kind: 'err',
      code: 'scope-mismatch',
      message: 'Body `scope` does not match query scopeKind/scopeId.',
    };
  }
  return bodyScope;
}

/** The request body as an object; `{}` when it is empty or not a JSON object. */
function parseJsonObject(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function serializeSecretRecord(rec: SecretRecord): Record<string, unknown> {
  return {
    scope: rec.scope as unknown as Record<string, unknown>,
    envName: rec.envName as unknown as string,
    name: rec.name,
    currentVersion: rec.currentVersion,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    ...(rec.revokedAt !== undefined && { revokedAt: rec.revokedAt }),
    ...(rec.revokeReason !== undefined && { revokeReason: rec.revokeReason }),
    ...(rec.tags !== undefined && { tags: rec.tags }),
    ...(rec.rotationDueAt !== undefined && { rotationDueAt: rec.rotationDueAt }),
  };
}

function serializeVersion(rec: SecretVersionRecord): Record<string, unknown> {
  return {
    scope: rec.scope as unknown as Record<string, unknown>,
    envName: rec.envName as unknown as string,
    name: rec.name,
    versionId: rec.versionId,
    createdAt: rec.createdAt,
    // Redaction: `value` is ALWAYS null on getVersion / listVersions.
    // The only `value`-returning path is `resolve`, which has no HTTP
    // surface.
    value: null,
    ...(rec.revokedAt !== undefined && { revokedAt: rec.revokedAt }),
  };
}

function serializeRotationStatus(s: RotationStatus): Record<string, unknown> {
  return {
    rotationId: s.rotationId,
    status: s.status,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    ...(s.newVersionId !== undefined && { newVersionId: s.newVersionId }),
    ...(s.oldVersionId !== undefined && { oldVersionId: s.oldVersionId }),
    ...(s.error !== undefined && { error: s.error }),
  };
}
