// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { RunBinding } from '@kindgi/runtime';
import type { RunId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { withholdFromReplay } from '../middleware/idempotency.js';
import { MAX_PUBLIC_RUN_TOKEN_RUNS, type MintPublicRunTokenResult } from '../public-run-token.js';
import type { AppEnv } from '../types.js';

export interface PublicRunTokenIssuer {
  readonly mint: (
    tenantId: TenantId,
    runIds: readonly RunId[],
    ttlSeconds: number,
  ) => MintPublicRunTokenResult;
  readonly defaultTtlSeconds: number;
  readonly maxTtlSeconds: number;
}

const BODY_FIELDS = new Set(['runIds', 'expiresInSeconds']);

/**
 * `POST /v1/tokens/public`: mint a public run token for runs the caller
 * may read. The token itself can't reach this route.
 */
export function publicRunTokensRouter(
  runBinding: RunBinding,
  issuer: PublicRunTokenIssuer,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const error = (code: string, message: string, details: Record<string, unknown> = {}) => {
      c.status(statusFor(code) as never);
      return c.json(toWireError({ code, message, ...details }, requestId));
    };

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return error('bad-input', 'Request body must be valid JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return error('bad-input', 'Request body must be a JSON object');
    }
    const fields = body as Record<string, unknown>;
    const unknown = Object.keys(fields).find((key) => !BODY_FIELDS.has(key));
    if (unknown !== undefined) return error('unknown-field', `Unknown field \`${unknown}\``);

    const runIds = fields.runIds;
    if (
      !Array.isArray(runIds) ||
      runIds.length === 0 ||
      runIds.length > MAX_PUBLIC_RUN_TOKEN_RUNS ||
      !runIds.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      return error(
        'bad-input',
        `\`runIds\` must be 1–${MAX_PUBLIC_RUN_TOKEN_RUNS} non-empty run ids`,
      );
    }
    const ttl = fields.expiresInSeconds ?? issuer.defaultTtlSeconds;
    if (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > issuer.maxTtlSeconds) {
      return error(
        'bad-input',
        `\`expiresInSeconds\` must be an integer in 1–${issuer.maxTtlSeconds}`,
      );
    }

    const unique = [...new Set(runIds as string[])] as RunId[];
    for (const runId of unique) {
      const row = await runBinding.getRun(tenantId, runId);
      if (row === null) {
        return error('run-not-found', `No run with id ${runId}`, { runId });
      }
      if (
        authorizer !== undefined &&
        !(await authorizer.can(c, 'read', ref('project', row.projectId as unknown as string)))
      ) {
        return error('permission-denied', `Not allowed to read run ${runId}`, { runId });
      }
    }

    const minted = issuer.mint(tenantId, unique, ttl as number);
    if (minted.kind === 'err') return error('token-mint-failed', minted.message);
    // The token is shown once: an Idempotency-Key repeat doesn't get it.
    withholdFromReplay(c);
    c.status(201);
    return c.json({
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      runIds: unique,
    });
  });

  return r;
}
