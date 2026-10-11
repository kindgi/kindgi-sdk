// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { AdapterFactoryRegistry, PrepareEvent } from '@kindgi/capabilities';
import type { Cursor, TenantId } from '@kindgi/types';

import {
  ADAPTER_KINDS,
  ADAPTER_STATUSES,
  type AdapterInfo,
  type AdapterKind,
  type AdapterRegistryBinding,
  type AdapterStatus,
  type AdapterTestOutcome,
} from '../adapter-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { tenantResourceAccess } from './tenant-access.js';

/**
 * Adapters resource routes — part of the admin control plane. Unified
 * surface over every adapter kind the deployment wired: model
 * providers, embedding providers, blob storage, sandbox providers,
 * eval judges.
 *
 * Read-only over HTTP, plus a smoke-test probe and a prepare stream:
 *
 *   - `GET  /v1/adapters`                — cursor-paginated list with
 *                                          optional `kind` / `status` filters.
 *   - `GET  /v1/adapters/:adapterId`     — single adapter (404 if unknown).
 *   - `POST /v1/adapters/:adapterId/test` — probe. Idempotency-Key applies.
 *   - `POST /v1/adapters/:adapterId/prepare` — SSE stream of the
 *                                          adapter's `prepare()` events.
 *
 * Adapter lifecycle (register / unregister / reconfigure) is a
 * deployment concern — see `AdapterRegistryBinding` JSDoc. The routes
 * here never mutate the wired set.
 *
 * Probe failures return HTTP 200 with `ok: false` — a failed probe is a
 * valid observation, not a server error (`docs/API-ROUTE-CONVENTIONS.md` §4).
 * The route only maps 5xx when the probe machinery itself broke.
 */
export function adaptersRouter(
  binding: AdapterRegistryBinding,
  factories?: AdapterFactoryRegistry,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', tenantResourceAccess(authorizer));

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const kindRaw = c.req.query('kind');
    const statusRaw = c.req.query('status');

    let kindFilter: AdapterKind | undefined;
    if (kindRaw !== undefined && kindRaw.length > 0) {
      if (!(ADAPTER_KINDS as readonly string[]).includes(kindRaw)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `\`kind\` "${kindRaw}" is not a known adapter kind (one of: ${ADAPTER_KINDS.join(
                ', ',
              )})`,
            },
            requestId,
          ),
        );
      }
      kindFilter = kindRaw as AdapterKind;
    }

    let statusFilter: AdapterStatus | undefined;
    if (statusRaw !== undefined && statusRaw.length > 0) {
      if (!(ADAPTER_STATUSES as readonly string[]).includes(statusRaw)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `\`status\` "${statusRaw}" is not a known adapter status (one of: ${ADAPTER_STATUSES.join(
                ', ',
              )})`,
            },
            requestId,
          ),
        );
      }
      statusFilter = statusRaw as AdapterStatus;
    }

    const hasFilter = kindFilter !== undefined || statusFilter !== undefined;
    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(hasFilter && {
        filter: {
          ...(kindFilter !== undefined && { kind: kindFilter }),
          ...(statusFilter !== undefined && { status: statusFilter }),
        },
      }),
    });
    return c.json({
      data: page.data.map(serializeAdapter),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:adapterId ----------
  r.get('/:adapterId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const adapterId = c.req.param('adapterId');

    const adapter = await binding.get({ tenantId, adapterId });
    if (adapter === null) {
      c.status(statusFor('adapter-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'adapter-not-found',
            message: `No adapter registered with id "${adapterId}"`,
            adapterId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeAdapter(adapter));
  });

  // ---------- POST /:adapterId/test ----------
  r.post('/:adapterId/test', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const adapterId = c.req.param('adapterId');

    // Body is optional. Empty body OR `{}` OR omitted body → no
    // `input` handed to the binding (it picks the default probe).
    let probeInput: Readonly<Record<string, unknown>> | undefined;
    const raw = await c.req.text();
    if (raw.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
        );
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: 'Request body must be a JSON object' },
            requestId,
          ),
        );
      }
      probeInput = parsed as Readonly<Record<string, unknown>>;
    }

    const outcome = await binding.test({
      tenantId,
      adapterId,
      ...(probeInput !== undefined && { input: probeInput }),
    });
    if (outcome === null) {
      c.status(statusFor('adapter-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'adapter-not-found',
            message: `No adapter registered with id "${adapterId}"`,
            adapterId,
          },
          requestId,
        ),
      );
    }
    // Probe failure is data — HTTP 200 with `ok: false` in the body.
    return c.json(serializeTestOutcome(outcome));
  });

  // ---------- POST /:adapterId/prepare ----------
  // SSE stream — iterates `entry.prepare(params)` and pushes each
  // PrepareEvent as an SSE `data:` line. Returns 404 if the adapter
  // id is unknown to the in-process factory registry, 400 if the
  // adapter has no `prepare()` (e.g. anthropic — nothing to
  // download), and 501 if the deployment didn't wire an
  // `adapterFactories` binding at all.
  r.post('/:adapterId/prepare', async (c) => {
    const requestId = c.get('requestId');
    const adapterId = c.req.param('adapterId');

    if (factories === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message:
              'Adapter prepare is not available — this deployment did not wire an adapterFactories binding.',
          },
          requestId,
        ),
      );
    }

    const entry = factories.get(adapterId);
    if (entry === undefined) {
      c.status(statusFor('adapter-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'adapter-not-found',
            message: `No adapter registered with id "${adapterId}"`,
            adapterId,
          },
          requestId,
        ),
      );
    }
    if (entry.prepare === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `Adapter "${adapterId}" does not require preparation (no prepare() implemented).`,
          },
          requestId,
        ),
      );
    }

    // Body carries adapter-specific `params` — passed through
    // unchanged (e.g. `{model: 'smollm2-360m'}` for in-process).
    let params: Readonly<Record<string, unknown>> | undefined;
    const bodyText = await c.req.text();
    if (bodyText.length > 0) {
      try {
        const parsed = JSON.parse(bodyText) as { readonly params?: unknown };
        if (parsed.params !== undefined) {
          if (parsed.params === null || typeof parsed.params !== 'object') {
            c.status(statusFor('bad-input') as never);
            return c.json(
              toWireError(
                { code: 'bad-input', message: '`params` must be an object when present.' },
                requestId,
              ),
            );
          }
          params = parsed.params as Readonly<Record<string, unknown>>;
        }
      } catch {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: 'Request body must be valid JSON.' },
            requestId,
          ),
        );
      }
    }

    const prepareStream = entry.prepare(params);

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of prepareStream) {
          await stream.writeSSE({
            event: event.kind,
            data: JSON.stringify(event),
          });
          if (event.kind === 'ready' || event.kind === 'error') break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorEvent: PrepareEvent = { kind: 'error', message };
        await stream.writeSSE({ event: 'error', data: JSON.stringify(errorEvent) });
      }
    });
  });

  return r;
}

function serializeAdapter(a: AdapterInfo): Record<string, unknown> {
  return {
    adapterId: a.adapterId,
    kind: a.kind,
    name: a.name,
    version: a.version,
    capabilities: a.capabilities,
    status: a.status,
    ...(a.config !== undefined && { config: a.config }),
    ...(a.statusReason !== undefined && { statusReason: a.statusReason }),
  };
}

function serializeTestOutcome(o: AdapterTestOutcome): Record<string, unknown> {
  return {
    ok: o.ok,
    latencyMs: o.latencyMs,
    probe: o.probe,
  };
}
