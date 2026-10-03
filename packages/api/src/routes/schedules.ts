// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Cursor, TenantId, TriggerId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type {
  CronTriggerRecord,
  RegisterCronTriggerInput,
  TriggerRegistryBinding,
  UpdateCronTriggerInput,
} from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * Schedules — cron-kind triggers.
 *
 * Seven routes, all soft-delete-shaped per framework convention:
 *   - POST   /v1/schedules                 (register)
 *   - GET    /v1/schedules                 (list, cursor-paginated)
 *   - GET    /v1/schedules/:triggerId      (get)
 *   - PATCH  /v1/schedules/:triggerId      (update cron/label/flowVersion)
 *   - POST   /v1/schedules/:triggerId/pause
 *   - POST   /v1/schedules/:triggerId/resume
 *   - POST   /v1/schedules/:triggerId/unregister  (tombstone — GC per policy)
 *
 * The `triggerId` URL param is the trigger's id; the response body
 * aliases it as `scheduleId` for a friendlier client surface.
 */
export function schedulesRouter(binding: TriggerRegistryBinding): Hono<AppEnv> {
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
    const cronExpression = requireString(body.config, 'config.cronExpression');
    if (flowId.kind === 'err') return bad(c, requestId, flowId.message);
    if (flowVersion.kind === 'err') return bad(c, requestId, flowVersion.message);
    if (cronExpression.kind === 'err') return bad(c, requestId, cronExpression.message);

    const rawConfig = (body.config ?? {}) as Record<string, unknown>;
    const registerInput: RegisterCronTriggerInput = {
      kind: 'cron',
      tenantId,
      flowId: flowId.value,
      flowVersion: flowVersion.value,
      config: {
        cronExpression: cronExpression.value,
        ...(typeof rawConfig.timezone === 'string' && { timezone: rawConfig.timezone }),
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
    return c.json(serializeSchedule(result.value as CronTriggerRecord));
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
      kind: 'cron',
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(statusFilter !== undefined && { status: statusFilter }),
    });
    return c.json({
      data: page.data.map((row) => serializeSchedule(row as CronTriggerRecord)),
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
    if (rec === null || rec.kind !== 'cron') return notFound(c, requestId, triggerId);
    return c.json(serializeSchedule(rec));
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
    const cfg: Partial<{ cronExpression: string; timezone: string; input: unknown }> = {};
    if (patchConfig !== undefined) {
      if (typeof patchConfig.cronExpression === 'string')
        cfg.cronExpression = patchConfig.cronExpression;
      if (typeof patchConfig.timezone === 'string') cfg.timezone = patchConfig.timezone;
      if ('input' in patchConfig) cfg.input = patchConfig.input;
    }

    const updateInput: UpdateCronTriggerInput = {
      kind: 'cron',
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
    return c.json(serializeSchedule(result.value as CronTriggerRecord));
  });

  // ---------- POST /:triggerId/pause ----------
  r.post('/:triggerId/pause', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const result = await binding.pause({ tenantId, triggerId });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    return c.json(serializeSchedule(result.value as CronTriggerRecord));
  });

  // ---------- POST /:triggerId/resume ----------
  r.post('/:triggerId/resume', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const result = await binding.resume({ tenantId, triggerId });
    if (result.kind === 'err') return lifecycleError(c, requestId, result.error, triggerId);
    return c.json(serializeSchedule(result.value as CronTriggerRecord));
  });

  // ---------- POST /:triggerId/unregister (soft delete) ----------
  r.post('/:triggerId/unregister', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const triggerId = c.req.param('triggerId') as TriggerId;
    const outcome = await binding.unregister({ tenantId, triggerId });
    return c.json({
      scheduleId: triggerId as unknown as string,
      unregistered: outcome.unregistered,
    });
  });

  return r;
}

// -----------------------------------------------------------------------
// Shared helpers (co-located to keep each router self-contained).
// -----------------------------------------------------------------------

function serializeSchedule(r: CronTriggerRecord): Record<string, unknown> {
  return {
    scheduleId: r.triggerId as unknown as string,
    triggerId: r.triggerId as unknown as string,
    flowId: r.flowId,
    flowVersion: r.flowVersion,
    cronExpression: r.config.cronExpression,
    ...(r.config.timezone !== undefined && { timezone: r.config.timezone }),
    ...(r.config.input !== undefined && { input: r.config.input }),
    label: r.label,
    status: r.status,
    nextFireAt: r.nextFireAt,
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
