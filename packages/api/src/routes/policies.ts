// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type { Cursor, TenantId } from '@kindgi/types';

import {
  APPLIED_POLICY_KINDS,
  POLICY_KINDS,
  type Policy,
  type PolicyKind,
  type PolicyRegistryBinding,
  isAppliedPolicyKind,
  validatePolicySpec,
} from '@kindgi/policy-contract';
import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * Policies resource routes — part of the admin control plane. Full
 * versioned CRUD, mirroring `flows` 1:1.
 *
 * The registry is intentionally kind-neutral: the wire body carries a
 * `kind` discriminator and a `spec` object whose shape is dictated by
 * that kind. The route validates the top-level shape (id, tenantId,
 * semver version, kind ∈ closed enum, spec is an object), and `spec`
 * against its kind's contract where `@kindgi/policy-contract` has one
 * (`tool-errors`, `hitl`) — a policy that couldn't be applied is refused
 * here, not found out on a turn. Other kinds' specs are their runtime
 * consumer's to validate.
 *
 * Enforcement is out of scope. This is the *registry* surface only.
 * Runtime consumers (e.g. `@kindgi/capabilities` `route` for
 * `model-routing`, adapter-allowlist checks, retention sweeps) read
 * policies from this store and apply them at their own boundary.
 */
export function policiesRouter(binding: PolicyRegistryBinding): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const kindRaw = c.req.query('kind');
    const nameRaw = c.req.query('name');

    if (kindRaw !== undefined && kindRaw.length > 0 && !isPolicyKind(kindRaw)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `Unknown policy kind "${kindRaw}". Expected one of: ${POLICY_KINDS.join(', ')}.`,
          },
          requestId,
        ),
      );
    }

    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(kindRaw !== undefined && kindRaw.length > 0 && { policyKind: kindRaw as PolicyKind }),
      ...(nameRaw !== undefined && nameRaw.length > 0 && { nameFilter: nameRaw }),
    });
    return c.json({
      data: page.data.map(serializePolicy),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:policyId (latest version) ----------
  r.get('/:policyId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const policyId = c.req.param('policyId');

    const policy = await binding.get({ tenantId, policyId });
    if (policy === null) {
      // 410 gone (head exists, no active version) vs 404 not-found.
      const exists = await binding.headExists({ tenantId, policyId });
      if (exists) {
        c.status(statusFor('policy-gone') as never);
        return c.json(
          toWireError(
            {
              code: 'policy-gone',
              message: `Policy "${policyId}" has no active versions; reinstate a tombstoned version or publish a new one`,
              policyId,
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('policy-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'policy-not-found',
            message: `No policy registered with id "${policyId}"`,
            policyId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializePolicy(policy));
  });

  // ---------- GET /:policyId/versions (list versions) ----------
  r.get('/:policyId/versions', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const policyId = c.req.param('policyId');
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    // `?includeTombstoned=true` surfaces soft-tombstoned rows alongside
    // active ones. Rows carry `unregisteredAt` (ISO string) iff
    // tombstoned. Absent / anything else → active-only (the default).
    const includeTombstoned = c.req.query('includeTombstoned') === 'true';

    // Confirm the id exists at all — an empty versions list from the
    // binding is ambiguous (no versions vs. unknown id). `headExists`
    // returns true for the derived-retired state (all versions
    // tombstoned) too, so the includeTombstoned=true caller sees the
    // history even when every version has been unregistered.
    const exists = await binding.headExists({ tenantId, policyId });
    if (!exists) {
      c.status(statusFor('policy-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'policy-not-found',
            message: `No policy registered with id "${policyId}"`,
            policyId,
          },
          requestId,
        ),
      );
    }

    const page = await binding.listVersions({
      tenantId,
      policyId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(includeTombstoned && { includeTombstoned: true }),
    });
    return c.json({
      data: page.data.map(serializePolicyVersionRow),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:policyId/versions/:version ----------
  r.get('/:policyId/versions/:version', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const policyId = c.req.param('policyId');
    const version = c.req.param('version');

    const policy = await binding.getVersion({ tenantId, policyId, version });
    if (policy === null) {
      c.status(statusFor('policy-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'policy-not-found',
            message: `No policy "${policyId}" at version "${version}"`,
            policyId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json(serializePolicy(policy));
  });

  // ---------- POST / (publish) ----------
  r.post('/', async (c) => {
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

    // Validate the wire shape, and `spec` for the kinds whose contract
    // lives in `@kindgi/policy-contract`.
    const validation = validatePolicy(body, tenantId);
    if (validation.kind === 'err') {
      c.status(statusFor('validation-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'validation-failed',
            message: validation.error.message,
            issues: validation.error.issues as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }

    // A known kind no runtime consumer applies yet: publishing it would
    // change nothing, silently.
    if (!isAppliedPolicyKind(validation.value.kind)) {
      c.status(statusFor('kind-not-applied') as never);
      return c.json(
        toWireError(
          {
            code: 'kind-not-applied',
            message: `This runtime doesn't apply "${validation.value.kind}" policies yet, so publishing one would change nothing. Policy kinds it applies: ${APPLIED_POLICY_KINDS.join(', ')}.`,
            kind: validation.value.kind,
            appliedKinds: [...APPLIED_POLICY_KINDS],
          },
          requestId,
        ),
      );
    }

    const outcome = await binding.publish({ tenantId, policy: validation.value });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('policy-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'policy-already-registered',
            message: `Policy "${outcome.policyId}" version "${outcome.version}" is already registered`,
            policyId: outcome.policyId,
            version: outcome.version,
          },
          requestId,
        ),
      );
    }
    c.status(201);
    return c.json({ policyId: outcome.policyId, version: outcome.version });
  });

  // ---------- POST /:policyId/versions/:version/unregister ----------
  r.post('/:policyId/versions/:version/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const policyId = c.req.param('policyId');
    const version = c.req.param('version');

    const outcome = await binding.unregister({ tenantId, policyId, version });
    if (!outcome.unregistered) {
      c.status(statusFor('policy-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'policy-not-found',
            message: `No policy "${policyId}" at version "${version}" to unregister`,
            policyId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({ policyId, version, unregistered: true });
  });

  // ---------- POST /:policyId/versions/:version/reinstate ----------
  r.post('/:policyId/versions/:version/reinstate', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const policyId = c.req.param('policyId');
    const version = c.req.param('version');
    const outcome = await binding.reinstateVersion({ tenantId, policyId, version });
    if (outcome.kind === 'not-found') {
      c.status(statusFor('policy-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'policy-not-found',
            message: `No policy "${policyId}" at version "${version}" to reinstate`,
            policyId,
            version,
          },
          requestId,
        ),
      );
    }
    return c.json({
      policyId: outcome.policyId,
      version: outcome.version,
      wasTombstoned: outcome.wasTombstoned,
    });
  });

  return r;
}

function serializePolicy(p: Policy): Record<string, unknown> {
  return {
    id: p.id,
    tenantId: p.tenantId as unknown as string,
    version: p.version,
    kind: p.kind,
    ...(p.description !== undefined && { description: p.description }),
    spec: p.spec,
  };
}

/**
 * Version-list serializer — same shape as `serializePolicy` plus the
 * optional `unregisteredAt` timestamp when the row is tombstoned. Kept
 * separate so `get` / `getVersion` responses don't leak the field.
 */
function serializePolicyVersionRow(
  p: Policy & { readonly unregisteredAt?: string },
): Record<string, unknown> {
  return {
    ...serializePolicy(p),
    ...(p.unregisteredAt !== undefined && { unregisteredAt: p.unregisteredAt }),
  };
}

function isPolicyKind(value: string): value is PolicyKind {
  return (POLICY_KINDS as readonly string[]).includes(value);
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Wire-shape validator for `Policy`. Confirms the top-level fields the
 * registry needs (id, tenantId, semver version, kind ∈ closed enum,
 * spec is an object), then `spec` against its kind's contract
 * (`validatePolicySpec`); its issues are pathed under `spec`, e.g.
 * `spec/tools/acme.pay/mode`.
 */
function validatePolicy(
  body: unknown,
  tenantId: TenantId,
):
  | { kind: 'ok'; value: Policy }
  | {
      kind: 'err';
      error: { message: string; issues: readonly { path: string; message: string }[] };
    } {
  const b = body as Partial<Policy> & Record<string, unknown>;
  const issues: { path: string; message: string }[] = [];

  if (typeof b.id !== 'string' || b.id.length === 0) {
    issues.push({ path: 'id', message: 'policy.id must be a non-empty string' });
  }
  if (typeof b.version !== 'string' || !SEMVER_RE.test(b.version)) {
    issues.push({
      path: 'version',
      message: 'policy.version must be a semver string (e.g. "1.0.0")',
    });
  }
  if (typeof b.kind !== 'string' || !isPolicyKind(b.kind)) {
    issues.push({
      path: 'kind',
      message: `policy.kind must be one of: ${POLICY_KINDS.join(', ')}`,
    });
  }
  // tenantId is optional on the wire — when present, it must match the
  // caller's tenant (server-derived from the token). Cross-tenant
  // publish is not allowed.
  if (b.tenantId !== undefined) {
    if (
      typeof b.tenantId !== 'string' ||
      (b.tenantId as unknown as string) !== (tenantId as unknown as string)
    ) {
      issues.push({
        path: 'tenantId',
        message: 'policy.tenantId must match the caller tenant',
      });
    }
  }
  if (
    b.spec === undefined ||
    b.spec === null ||
    typeof b.spec !== 'object' ||
    Array.isArray(b.spec)
  ) {
    issues.push({ path: 'spec', message: 'policy.spec must be an object' });
  } else if (typeof b.kind === 'string' && isPolicyKind(b.kind)) {
    for (const issue of validatePolicySpec(b.kind, b.spec)) {
      issues.push({
        path: `spec${issue.path}`,
        message: `policy.spec${issue.path} ${issue.message}`,
      });
    }
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    issues.push({ path: 'description', message: 'policy.description must be a string' });
  }

  if (issues.length > 0) {
    return {
      kind: 'err',
      error: { message: issues[0]?.message ?? 'policy validation failed', issues },
    };
  }

  const value: Policy = {
    id: b.id as string,
    tenantId,
    version: b.version as string,
    kind: b.kind as PolicyKind,
    ...(typeof b.description === 'string' && { description: b.description }),
    spec: b.spec as Readonly<Record<string, unknown>>,
  };
  return { kind: 'ok', value };
}
