// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { findProjectsReal, postDeploymentReal } from '../src/deploy/post.js';
import type { PostDeploymentBody } from '../src/deploy/runners.js';

/** A `fetch` that answers every request with `status`, `body` and `headers`. */
function answering(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as typeof fetch;
}

const post = (fetchImpl: typeof fetch) =>
  postDeploymentReal({
    endpoint: 'https://api.example.com',
    token: 'kgi_bt_test',
    body: {} as PostDeploymentBody,
    idempotencyKey: 'k1',
    fetchImpl,
  });

describe('postDeploymentReal', () => {
  test('X-Idempotent-Replay on a refusal is carried to the result', async () => {
    const result = await post(
      answering(
        403,
        { error: { code: 'signer-not-trusted', message: 'not trusted' } },
        { 'X-Idempotent-Replay': 'true' },
      ),
    );
    expect(result).toMatchObject({ kind: 'wire-error', status: 403, idempotentReplay: true });
  });

  test('and on a success', async () => {
    const result = await post(
      answering(201, { deploymentId: 'd1' }, { 'X-Idempotent-Replay': 'true' }),
    );
    expect(result).toMatchObject({ kind: 'created', idempotentReplay: true });
  });

  test('without the header, no replay is claimed', async () => {
    const result = await post(
      answering(403, { error: { code: 'signer-not-trusted', message: 'x' } }),
    );
    expect(result.kind === 'wire-error' && result.idempotentReplay).toBeFalsy();
    expect(result).not.toHaveProperty('idempotentReplay');
  });

  test("a refusal's Retry-After (whole seconds) and the limit it names are carried", async () => {
    const result = await post(
      answering(
        429,
        {
          error: {
            code: 'rate-limit-exceeded',
            message: 'used up',
            details: { limit: 'schema-compile-time', budgetMs: 2000 },
          },
        },
        { 'Retry-After': '23' },
      ),
    );
    expect(result).toMatchObject({
      kind: 'wire-error',
      status: 429,
      retryAfterSeconds: 23,
      error: { code: 'rate-limit-exceeded', limit: 'schema-compile-time' },
    });
  });

  test('a Retry-After that is not whole seconds, or a limit that is not a name, is left out', async () => {
    for (const retryAfter of ['1.5', 'Wed, 21 Oct 2026 07:28:00 GMT', '-1', '']) {
      const result = await post(
        answering(
          429,
          { error: { code: 'rate-limit-exceeded', message: 'x', details: { limit: 7 } } },
          { 'Retry-After': retryAfter },
        ),
      );
      expect(result).not.toHaveProperty('retryAfterSeconds');
      expect(result.kind === 'wire-error' && result.error).not.toHaveProperty('limit');
    }
  });
});

describe('findProjectsReal: --project <slug>', () => {
  const pages: Record<string, unknown> = {
    first: {
      data: [
        { id: 'p-1', name: 'Acme shop', slug: 'acme-shop' },
        { id: 'p-2', name: 'Shared', slug: 'shop', orgId: 'org-a' },
      ],
      hasMore: true,
      nextCursor: 'c 2',
    },
    second: {
      data: [{ id: 'p-3', name: 'Shared', slug: 'shop', orgId: 'org-b' }],
      hasMore: false,
    },
  };
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const page = String(url).includes('cursor=') ? pages.second : pages.first;
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;

  test('reads every page and keeps the projects with the slug', async () => {
    urls.length = 0;
    const found = await findProjectsReal({
      endpoint: 'https://api.example.com/',
      token: 'tok',
      slug: 'shop',
      fetchImpl,
    });
    expect(found).toEqual({
      kind: 'ok',
      projects: [
        { id: 'p-2', name: 'Shared', orgId: 'org-a' },
        { id: 'p-3', name: 'Shared', orgId: 'org-b' },
      ],
    });
    expect(urls).toEqual([
      'https://api.example.com/v1/projects?limit=100',
      'https://api.example.com/v1/projects?limit=100&cursor=c%202',
    ]);
  });

  test('an error answer is an error, naming its status and code', async () => {
    const refusing = (async () =>
      new Response(JSON.stringify({ error: { code: 'forbidden', message: 'no' } }), {
        status: 403,
      })) as unknown as typeof fetch;
    expect(
      await findProjectsReal({
        endpoint: 'https://api.example.com',
        token: 'tok',
        slug: 'x',
        fetchImpl: refusing,
      }),
    ).toEqual({
      kind: 'error',
      message: 'GET https://api.example.com/v1/projects answered HTTP 403 (forbidden)',
    });
  });
});
