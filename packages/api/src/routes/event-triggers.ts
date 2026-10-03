// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Cursor, TenantId, TriggerId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  EventTriggerRecord,
  RegisterEventTriggerInput,
  TriggerRegistryBinding,
  UpdateEventTriggerInput,
} from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * Event triggers — fire a flow run when a matching event arrives on
 * the framework event bus.
 *
 * Seven routes, mirroring the schedules surface. This surface registers
 * triggers; it does not publish events.
 */
export function eventTriggersRouter(binding: TriggerRegistryBinding): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- POST / (register) ----------
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;

    const flowId = requireString(body, 'flowId');
    const flowVersion = requireString(body, 'flowVersion');
    const eventKind = requireString(body.config, 'config.eventKind');
    if (flowId.kind === 'err') return bad(c, requestId, flowId.message);
    if (flowVersion.kind === 'err') return bad(c, requestId, flowVersion.message);
    if (eventKind.kind === 'err') return bad(c, requestId, eventKind.message);

    const rawConfig = (body.config ?? {}) as Record<string, unknown>;
    const registerInput: RegisterEventTriggerInput = {
      kind: 'event',
      tenantId,
      flowId: flowId.value,
      flowVersion: flowVersion.value,
      config: {
        eventKind: eventKind.value,
        ...('input' in rawConfig && { input: rawConfig.input }),
      },
      ...(typeof body.label === 'string' && body.label.length > 0 && { label: body.label }),
    };

    const result = await binding.register(registerInput);
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError({ code: result.error.code, message: result.error.message }, requestId),
      );
    }
    c.status(201);
    return c.json(serializeEventTrigger(result.value as EventTriggerRecord));
  });

  // ---------- GET / (list) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const statusRaw = c.req.query('status');

    let statusFilter: 'active' | 'paused' | undefined;
    if (statusRaw === 'active' || statusRaw === 'paused') statusFilter = statusRaw;

    const page = await binding.list({
      tenantId,
      kind: 'event',
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(statusFilter !== undefined && { status: statusFilter }),
    });
    return c.json({
      data: page.data.map((row) => serializeEventTrigger(row as EventTriggerRecord)),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:triggerId (get) ----------
  r.get('/:triggerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;

    const rec = await binding.get({ tenantId, triggerId });
    if (rec === null || rec.kind !== 'event') return notFound(c, requestId, triggerId);
    return c.json(serializeEventTrigger(rec));
  });

  // ---------- PATCH /:triggerId (update) ----------
  r.patch('/:triggerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;

    const parsed = await parseJsonObject(c, requestId);
    if (parsed.kind === 'err') return parsed.response;
    const body = parsed.value;

    const patchConfig = body.config as Record<string, unknown> | undefined;
    const cfg: Partial<{ eventKind: string; input: unknown }> = {};
    if (patchConfig !== undefined) {
      if (typeof patchConfig.eventKind === 'string') cfg.eventKind = patchConfig.eventKind;
      if ('input' in patchConfig) cfg.input = patchConfig.input;
    }

    const updateInput: UpdateEventTriggerInput = {
      kind: 'event',
      tenantId,
      triggerId,
      ...(Object.keys(cfg).length > 0 && { config: cfg }),
      ...('label' in body && { label: body.label === null ? null : (body.label as string) }),
      ...(typeof body.flowVersion === 'string' && { flowVersion: body.flowVersion }),
    };

    const result = await binding.update(updateInput);
    if (result.kind === 'err') {
      c.status(statusFor(result.error.code) as never);
      return c.json(
        toWireError(
          {
            code: result.error.code,
            message: result.error.message,
            triggerId: triggerId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeEventTrigger(result.value as EventTriggerRecord));
  });

  // ---------- POST /:triggerId/pause ----------
  r.post('/:triggerId/pause', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const result = await binding.pause({ tenantId, triggerId });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    return c.json(serializeEventTrigger(result.value as EventTriggerRecord));
  });

  // ---------- POST /:triggerId/resume ----------
  r.post('/:triggerId/resume', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const result = await binding.resume({ tenantId, triggerId });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    return c.json(serializeEventTrigger(result.value as EventTriggerRecord));
  });

  // ---------- POST /:triggerId/unregister (soft delete) ----------
  r.post('/:triggerId/unregister', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const outcome = await binding.unregister({ tenantId, triggerId });
    return c.json({
      eventTriggerId: triggerId as unknown as string,
      unregistered: outcome.unregistered,
    });
  });

  return r;
}

function serializeEventTrigger(r: EventTriggerRecord): Record<string, unknown> {
  return {
    eventTriggerId: r.triggerId as unknown as string,
    triggerId: r.triggerId as unknown as string,
    flowId: r.flowId,
    flowVersion: r.flowVersion,
    eventKind: r.config.eventKind,
    ...(r.config.input !== undefined && { input: r.config.input }),
    label: r.label,
    status: r.status,
    lastFiredAt: r.lastFiredAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

type ParseOk<T> = { readonly kind: 'ok'; readonly value: T };
type ParseErr = { readonly kind: 'err'; readonly response: Response };

async function parseJsonObject(
  c: Context<AppEnv>,
  requestId: string,
): Promise<ParseOk<Record<string, unknown>> | ParseErr> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.status(statusFor('bad-input') as never);
    return {
      kind: 'err',
      response: c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      ),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    c.status(statusFor('bad-input') as never);
    return {
      kind: 'err',
      response: c.json(
        toWireError(
          { code: 'bad-input', message: 'Request body must be a JSON object' },
          requestId,
        ),
      ),
    };
  }
  return { kind: 'ok', value: body as Record<string, unknown> };
}

function requireString(
  obj: unknown,
  path: string,
):
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'err'; readonly message: string } {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') {
      return { kind: 'err', message: `\`${path}\` is required` };
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur !== 'string' || cur.length === 0) {
    return { kind: 'err', message: `\`${path}\` is required` };
  }
  return { kind: 'ok', value: cur };
}

function bad(c: Context<AppEnv>, requestId: string, message: string): Response {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}

function notFound(c: Context<AppEnv>, requestId: string, triggerId: TriggerId): Response {
  c.status(statusFor('trigger-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'trigger-not-found',
        message: `No trigger with id "${triggerId as unknown as string}"`,
        triggerId: triggerId as unknown as string,
      },
      requestId,
    ),
  );
}

function lifecycleError(
  c: Context<AppEnv>,
  requestId: string,
  error: { readonly code: string; readonly message: string },
  triggerId: TriggerId,
): Response {
  c.status(statusFor(error.code) as never);
  return c.json(
    toWireError(
      { code: error.code, message: error.message, triggerId: triggerId as unknown as string },
      requestId,
    ),
  );
}
