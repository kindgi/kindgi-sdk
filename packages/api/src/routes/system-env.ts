// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, TenantId } from '@kindgi/types';
import { parseCloudSecretVersion } from '@kindgi/types';

import type {
  EnvCloudSecretBinding,
  EnvCloudSecretRecord,
  EnvCloudSecretSetOutcome,
} from '../env-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { type SystemTenantDirectory, withSystemTenantContext } from '../middleware/system.js';
import { type ServedEnvRule, refuseUnservedValue } from '../served-env.js';
import type { AppEnv } from '../types.js';
import { cloudSecretsUnsupported, requireEnvName, requireScope } from './env.js';
import { clampLimit } from './pagination.js';
import { type WriteAuditInput, auditWrite } from './write-audit.js';

/** The body `PUT …/env/:name` takes: these and no other fields. */
const SET_FIELDS = new Set(['cloudSecret', 'ifRevision']);

/**
 * The operator's cloud secrets, under `/v1/system/tenants`, with the
 * `system:env-refs` scope. Each sets an env name, at a scope of the tenant
 * and one env, to a version of a secret the operator's cloud holds:
 * `projects/<project>/secrets/<secret>/versions/<number>`. A pack service
 * is given that name, and its cloud reads the value as the pack service's
 * own account; the runtime never holds it. That account is every pack
 * service's, so only a system key sets one.
 *
 * - **`PUT /:tenantId/env/:name?envName=&scopeKind=&scopeId=`**
 *   `{ cloudSecret, ifRevision? }`: sets or changes one, and answers it.
 *   `400 cloud-secret-invalid` when `cloudSecret` isn't that form, a
 *   numbered version of a secret whose id doesn't start with `kp-`;
 *   `409 env-write-conflict` when `ifRevision` isn't the stored one.
 * - **`DELETE /:tenantId/env/:name?envName=&scopeKind=&scopeId=`**: removes
 *   one, `{ deleted }`; `false` when there's none.
 * - **`GET /:tenantId/env?envName=&scopeKind=&scopeId=&cursor=&limit=`**:
 *   the ones set at that scope and env, with their `cloudSecret`. The
 *   tenant's own list (`GET /v1/env/cloud-secrets`) leaves it out.
 *
 * Each acts through `withSystemTenantContext`: an unknown tenant is `404
 * tenant-not-found`, and a closing one is frozen (`409 tenant-closing`)
 * for writes. A runtime with no `cloudSecrets` store answers each `501
 * cloud-secrets-unsupported`. Each write is recorded as the env routes'
 * are (`env-set`, `env-deleted`), naming the system key and marked
 * `cloudSecret`, never with the path: a tenant may read those rows.
 */
export function systemEnvRouter(options: {
  readonly cloudSecrets: EnvCloudSecretBinding | undefined;
  readonly directory: SystemTenantDirectory;
  readonly authorizer?: Authorizer;
  readonly auditEvents?: AuditEventBinding;
  readonly servedEnv?: ServedEnvRule;
}): Hono<AppEnv> {
  const { cloudSecrets, directory, authorizer, auditEvents, servedEnv } = options;
  const r = new Hono<AppEnv>();
  const scoped = (write: boolean) => ({
    scope: 'system:env-refs' as const,
    ...(write && { refuse: ['closing' as const] }),
    ...(authorizer !== undefined && { authorizer }),
  });

  r.put('/:tenantId/env/:name', async (c) =>
    withSystemTenantContext(c, directory, c.req.param('tenantId'), scoped(true), async (tenant) => {
      if (cloudSecrets === undefined) return cloudSecretsUnsupported(c);
      const at = whereFrom(c, tenant.id);
      if (at instanceof Response) return at;
      const body = await readSetBody(c);
      if (body instanceof Response) return body;
      const key = { ...at, name: c.req.param('name') };
      const unserved = await refuseUnservedValue(servedEnv, {
        ...key,
        tenantId: tenant.id,
        kind: 'cloud secret',
      });
      if (unserved !== undefined) {
        c.status(statusFor(unserved.code) as never);
        return c.json(toWireError(unserved, c.get('requestId')));
      }
      const outcome = await cloudSecrets.set({ ...key, ...body });
      return answerSet(c, auditEvents, outcome, { kind: 'env-set', ...key, cloudSecret: true });
    }),
  );

  r.delete('/:tenantId/env/:name', async (c) =>
    withSystemTenantContext(c, directory, c.req.param('tenantId'), scoped(true), async (tenant) => {
      if (cloudSecrets === undefined) return cloudSecretsUnsupported(c);
      const at = whereFrom(c, tenant.id);
      if (at instanceof Response) return at;
      const key = { ...at, name: c.req.param('name') };
      const outcome = await cloudSecrets.delete(key);
      // Only a delete that removed something is recorded.
      if (outcome.deleted) {
        await auditWrite(c, auditEvents, {
          kind: 'env-deleted',
          ...key,
          outcome: 'succeeded',
          cloudSecret: true,
        });
      }
      return c.json({ deleted: outcome.deleted });
    }),
  );

  r.get('/:tenantId/env', async (c) =>
    withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      scoped(false),
      async (tenant) => {
        if (cloudSecrets === undefined) return cloudSecretsUnsupported(c);
        const at = whereFrom(c, tenant.id);
        if (at instanceof Response) return at;
        const cursor = c.req.query('cursor');
        const page = await cloudSecrets.list({
          ...at,
          limit: clampLimit(c.req.query('limit')),
          ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
        });
        return c.json({
          data: page.data.map(serializeCloudSecret),
          hasMore: page.nextCursor !== undefined,
          ...(page.nextCursor !== undefined && {
            nextCursor: page.nextCursor as unknown as string,
          }),
        });
      },
    ),
  );

  return r;
}

/** The scope and env the query names, in the tenant the path names; or why not. */
function whereFrom(
  c: Context<AppEnv>,
  tenantId: TenantId,
): { readonly scope: Scope; readonly envName: EnvName } | Response {
  const envName = requireEnvName(c.req.query('envName'));
  if (envName.kind === 'err') return fail(c, envName.code, envName.message);
  const scope = requireScope(c.req.query(), tenantId);
  if (scope.kind === 'err') return fail(c, scope.code, scope.message);
  return { scope: scope.scope, envName: envName.envName };
}

/** `{ cloudSecret, ifRevision? }`, checked; or why it isn't that. */
async function readSetBody(
  c: Context<AppEnv>,
): Promise<{ readonly cloudSecret: string; readonly ifRevision?: number } | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 'bad-input', 'Request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail(c, 'bad-input', 'Request body must be an object');
  }
  const b = body as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(b).filter((k) => !SET_FIELDS.has(k));
  if (unknown.length > 0) {
    return fail(
      c,
      'bad-input',
      `Unknown field ${unknown.map((k) => `\`${k}\``).join(', ')}: the body is \`{ "cloudSecret", "ifRevision"? }\``,
    );
  }
  const parsed = parseCloudSecretVersion(b.cloudSecret);
  if (parsed.kind === 'err') return fail(c, 'cloud-secret-invalid', parsed.message);
  const cloudSecret = b.cloudSecret as string;
  const ifRevision = b.ifRevision;
  if (ifRevision === undefined) return { cloudSecret };
  if (typeof ifRevision !== 'number' || !Number.isInteger(ifRevision) || ifRevision < 0) {
    return fail(c, 'bad-input', '`ifRevision` must be a whole number when present');
  }
  return { cloudSecret, ifRevision };
}

/** A set's answer, recorded either way: the cloud secret, or why the store refused it. */
async function answerSet(
  c: Context<AppEnv>,
  auditEvents: AuditEventBinding | undefined,
  outcome: EnvCloudSecretSetOutcome,
  audit: Omit<WriteAuditInput, 'outcome'>,
): Promise<Response> {
  if (outcome.kind === 'ok') {
    await auditWrite(c, auditEvents, {
      ...audit,
      outcome: 'succeeded',
      version: outcome.record.revision,
    });
    return c.json(serializeCloudSecret(outcome.record));
  }
  await auditWrite(c, auditEvents, {
    ...audit,
    outcome: 'failed',
    errorCode: outcome.kind === 'revision-conflict' ? 'env-write-conflict' : outcome.code,
  });
  if (outcome.kind === 'error') return fail(c, outcome.code, outcome.message);
  c.status(statusFor('env-write-conflict') as never);
  return c.json(
    toWireError(
      {
        code: 'env-write-conflict',
        message: `Stored revision is ${outcome.currentRevision}; retry with the current one.`,
        currentRevision: outcome.currentRevision,
      },
      c.get('requestId'),
    ),
  );
}

/** A cloud secret as the operator reads it: with its path. */
function serializeCloudSecret(rec: EnvCloudSecretRecord): Record<string, unknown> {
  return {
    scope: rec.scope as unknown as Record<string, unknown>,
    envName: rec.envName as unknown as string,
    name: rec.name,
    cloudSecret: rec.cloudSecret,
    revision: rec.revision,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function fail(c: Context<AppEnv>, code: string, message: string): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message }, c.get('requestId')));
}
