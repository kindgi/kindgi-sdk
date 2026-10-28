// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { Cursor, TenantId, TriggerId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { TriggerRegistryBinding, TriggerVersionRecord } from '../trigger-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/** The version record of one kind. */
type VersionOf<K extends TriggerVersionRecord['kind']> = Extract<TriggerVersionRecord, { kind: K }>;

/**
 * A trigger's versions on the wire, for each kind's routes: `GET
 * …/:triggerId/versions` (a page, newest first) and `GET
 * …/:triggerId/versions/:version`. The route has found the trigger, of
 * its own kind, and checked the caller may read it, as reading the trigger
 * does; `json` writes each version as that kind's routes name its fields.
 */
export async function versionsPage<K extends TriggerVersionRecord['kind']>(
  c: Context<AppEnv>,
  binding: TriggerRegistryBinding,
  triggerId: TriggerId,
  kind: K,
  json: (versions: readonly VersionOf<K>[]) => Promise<readonly Record<string, unknown>[]>,
): Promise<Response> {
  const cursorRaw = c.req.query('cursor');
  const page = await binding.listVersions({
    tenantId: c.get('tenantId') as TenantId,
    triggerId,
    limit: clampLimit(c.req.query('limit')),
    ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
  });
  return c.json({
    data: await json(page.data.filter((v): v is VersionOf<K> => v.kind === kind)),
    hasMore: page.nextCursor !== undefined,
    ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
  });
}

/** One version (`:version`, a positive integer), as {@link versionsPage}. */
export async function versionOne<K extends TriggerVersionRecord['kind']>(
  c: Context<AppEnv>,
  binding: TriggerRegistryBinding,
  triggerId: TriggerId,
  kind: K,
  json: (versions: readonly VersionOf<K>[]) => Promise<readonly Record<string, unknown>[]>,
): Promise<Response> {
  const requestId = c.get('requestId');
  const raw = c.req.param('version') ?? '';
  const version = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    c.status(statusFor('bad-input') as never);
    return c.json(
      toWireError(
        { code: 'bad-input', message: '`version` must be a positive integer', field: 'version' },
        requestId,
      ),
    );
  }
  const found = await binding.getVersion({
    tenantId: c.get('tenantId') as TenantId,
    triggerId,
    version,
  });
  if (found === null || found.kind !== kind) {
    c.status(statusFor('trigger-version-not-found') as never);
    return c.json(
      toWireError(
        {
          code: 'trigger-version-not-found',
          message: `Trigger "${triggerId as unknown as string}" has no version ${version}`,
          triggerId: triggerId as unknown as string,
          version,
        },
        requestId,
      ),
    );
  }
  const [body] = await json([found as VersionOf<K>]);
  return c.json(body);
}

/** What every kind's version says of itself; its route adds its ids and `definition`. */
export function versionFields(v: TriggerVersionRecord): Record<string, unknown> {
  return {
    version: v.version,
    createdAt: v.createdAt,
    ...(v.createdBy !== undefined && { createdBy: v.createdBy }),
    cause: v.cause,
  };
}
