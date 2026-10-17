// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import { type EnvName, type TenantId, makeEnvName } from '@kindgi/types';

import type { EnvBinding } from '../env-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { EnvNamesInput, SecretBinding } from '../secrets-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/** One store's env names (`listEnvNames`), or which store can't give them. */
type EnvNamesSource =
  | { readonly list: (input: EnvNamesInput) => Promise<readonly EnvName[]> }
  | { readonly missing: 'env' | 'secret' };

/**
 * `GET /v1/environments`: the env names the tenant holds an env value or a
 * secret under, at any scope, each once, in byte order, paged. For a tenant
 * admin: the names span every project.
 *
 * Each wired store gives its own names (`listEnvNames`). A store that can't
 * is answered `501 environments-unsupported`, never a list missing its names.
 * A page asks each store for one name more than it shows, so `hasMore` is
 * known without another read.
 */
export function environmentsRouter(deps: {
  readonly envBinding?: EnvBinding;
  readonly secretsBinding?: SecretBinding;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { authorizer } = deps;
  const sources: readonly EnvNamesSource[] = [
    ...(deps.envBinding === undefined ? [] : [source(deps.envBinding, 'env')]),
    ...(deps.secretsBinding === undefined ? [] : [source(deps.secretsBinding, 'secret')]),
  ];
  const r = new Hono<AppEnv>();

  if (authorizer !== undefined) {
    r.use('*', async (c, next) => {
      const tenantId = c.get('tenantId') as TenantId;
      const mw = authorizer.authorize('admin', () => ref('tenant', tenantId as unknown as string));
      return mw(c, next);
    });
  }

  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const missing = sources.find((s) => 'missing' in s);
    if (missing !== undefined && 'missing' in missing) {
      c.status(statusFor('environments-unsupported') as never);
      return c.json(
        toWireError(
          {
            code: 'environments-unsupported',
            message: `This runtime can't list its environments: its ${missing.missing} store doesn't say which env names it holds`,
          },
          requestId,
        ),
      );
    }
    const after = parseCursor(c.req.query('cursor'));
    if (after === 'bad') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: "`cursor` isn't one this list gave" }, requestId),
      );
    }
    const limit = clampLimit(c.req.query('limit'));
    const input: EnvNamesInput = {
      tenantId,
      limit: limit + 1,
      ...(after !== undefined && { after }),
    };
    const lists = await Promise.all(sources.map((s) => ('list' in s ? s.list(input) : [])));
    const names = [...new Set(lists.flat())].sort();
    const page = names.slice(0, limit);
    const last = page[page.length - 1];
    const hasMore = names.length > limit;
    return c.json({
      data: page.map((envName) => ({ envName })),
      hasMore,
      ...(hasMore && last !== undefined && { nextCursor: encodeCursor(last) }),
    });
  });
  return r;
}

function source(binding: EnvBinding | SecretBinding, kind: 'env' | 'secret'): EnvNamesSource {
  const list = binding.listEnvNames;
  return list === undefined ? { missing: kind } : { list: (input) => list.call(binding, input) };
}

/** The last name a page showed. */
function encodeCursor(envName: EnvName): string {
  return Buffer.from(envName, 'utf8').toString('base64url');
}

function parseCursor(raw: string | undefined): EnvName | undefined | 'bad' {
  if (raw === undefined || raw === '') return undefined;
  return makeEnvName(Buffer.from(raw, 'base64url').toString('utf8')) ?? 'bad';
}
