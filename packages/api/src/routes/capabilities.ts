// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { Cursor, TenantId } from '@kindgi/types';

import type { CapabilityDescriptor, CapabilityRegistryBinding } from '../capability-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { tenantResourceAccess } from './tenant-access.js';

/**
 * Capabilities resource routes — part of the admin control plane.
 * Read-only. Capabilities are framework-declared
 * (see `@kindgi/specs/capability.schema.json` + `@kindgi/capabilities.FEATURES`)
 * and deployment-extended at boot time via the caller-plugged
 * `CapabilityRegistryBinding`. Tenants do NOT author capabilities via
 * the HTTP surface — that would fork the closed-enum feature set the
 * router depends on.
 */
export function capabilitiesRouter(
  binding: CapabilityRegistryBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', tenantResourceAccess(authorizer));

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const featureRaw = c.req.query('feature');
    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(featureRaw !== undefined && featureRaw.length > 0 && { featureFilter: featureRaw }),
    });
    return c.json({
      data: page.data.map(serializeCapability),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:capabilityId ----------
  r.get('/:capabilityId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const capabilityId = c.req.param('capabilityId');

    const descriptor = await binding.get({ tenantId, capabilityId });
    if (descriptor === null) {
      c.status(statusFor('capability-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'capability-not-found',
            message: `No capability registered with id "${capabilityId}"`,
            capabilityId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeCapability(descriptor));
  });

  return r;
}

function serializeCapability(d: CapabilityDescriptor): Record<string, unknown> {
  return {
    id: d.id,
    feature: d.feature,
    description: d.description,
    ...(d.kind !== undefined && { kind: d.kind }),
    ...(d.paramsSchema !== undefined && { paramsSchema: d.paramsSchema }),
  };
}
