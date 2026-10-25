// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { DEPLOY_ENVELOPE_SCHEMA, type DeployEnvelope } from '../src/build/envelope.js';
import {
  buildPostBody,
  findProjectsReal,
  listEnvironmentOrdersReal,
  listProjectsReal,
  postDeploymentReal,
} from '../src/deploy/post.js';
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

describe('buildPostBody', () => {
  test("keeps the keys in a released CLI's order: the server fingerprints the body's bytes", () => {
    // A reorder would make the same envelope, deployed again by another
    // CLI version under the same Idempotency-Key, a different body there.
    const envelope: DeployEnvelope = {
      $schema: DEPLOY_ENVELOPE_SCHEMA,
      imageRef: 'ghcr.io/acme/kindgi-pack@sha256:00',
      imageDigest: 'sha256:00',
      artifactVersion: '1.0.0',
      index: {},
      indexHash: 'sha256:01',
      tenantId: 'acme',
      publishedAt: '2026-10-24T00:00:00.000Z',
      signerKeyId: 'acme-key',
      signerPublicKey: 'acme-public-key',
      signature: 'acme-signature',
    };
    expect(Object.keys(buildPostBody(envelope))).toEqual([
      'imageRef',
      'artifactVersion',
      'index',
      'indexHash',
      'signerKeyId',
      'signerPublicKey',
      'signature',
      'publishedAt',
    ]);
  });
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

  test("an image refusal's cause and limit are carried from details", async () => {
    const result = await post(
      answering(400, {
        error: {
          code: 'image-unverifiable',
          message: 'Extract /app/index.json failed: unpacks past 4 GiB',
          details: { imageRef: 'r', cause: 'image-limit-exceeded', limit: 'unpack' },
        },
      }),
    );
    expect(result).toMatchObject({
      kind: 'wire-error',
      status: 400,
      error: { code: 'image-unverifiable', cause: 'image-limit-exceeded', limit: 'unpack' },
    });
    const noCause = await post(
      answering(400, {
        error: { code: 'image-unverifiable', message: 'x', details: { cause: 7 } },
      }),
    );
    expect(noCause.kind === 'wire-error' && noCause.error).not.toHaveProperty('cause');
  });

  test("a validation refusal's details.issues are carried", async () => {
    const issues = [{ primitive: 'tool', index: 0, path: '/input', message: 'bad schema' }];
    const result = await post(
      answering(400, {
        error: { code: 'deployment-validation-failed', message: 'x', details: { issues } },
      }),
    );
    expect(result).toMatchObject({ kind: 'wire-error', error: { details: issues } });
  });
});

describe('postDeploymentReal: what a refusal names, from its details', () => {
  test("a validation refusal's issues are its details", async () => {
    const issues = [
      { primitive: 'tool', id: 'acme.score', path: '/inputSchema', message: 'not an object' },
    ];
    const result = await post(
      answering(400, {
        error: {
          code: 'deployment-validation-failed',
          message: 'Deployment manifest validation failed (1 issue)',
          details: { issues },
          requestId: 'r1',
        },
      }),
    );
    expect(result).toMatchObject({
      kind: 'wire-error',
      error: { code: 'deployment-validation-failed', details: issues },
    });
  });

  test('a refusal into a later environment carries its position and the first environment', async () => {
    const result = await post(
      answering(409, {
        error: {
          code: 'environment-takes-promotions',
          message: 'x',
          details: { position: 2, firstProjectId: 'p-staging' },
        },
      }),
    );
    expect(result).toMatchObject({
      kind: 'wire-error',
      status: 409,
      error: { code: 'environment-takes-promotions', position: 2, firstProjectId: 'p-staging' },
    });
    expect(result.kind === 'wire-error' && result.error).not.toHaveProperty('details');
  });

  test('a position that is not a whole number from 0, or a first environment that is not an id, is left out', async () => {
    for (const details of [
      { position: -1, firstProjectId: '' },
      { position: 1.5, firstProjectId: 7 },
      { position: '1', firstProjectId: null },
    ]) {
      const result = await post(
        answering(409, { error: { code: 'environment-takes-promotions', message: 'x', details } }),
      );
      const error = result.kind === 'wire-error' ? result.error : undefined;
      expect(error).toBeDefined();
      expect(error).not.toHaveProperty('position');
      expect(error).not.toHaveProperty('firstProjectId');
    }
    const first = await post(
      answering(409, {
        error: { code: 'environment-takes-promotions', message: 'x', details: { position: 0 } },
      }),
    );
    expect(first.kind === 'wire-error' && first.error.position).toBe(0);
  });
});

describe('listProjectsReal and listEnvironmentOrdersReal: every page', () => {
  /** Answers `path`'s first page, then its second when asked with the cursor. */
  function paged(path: string, first: unknown, second: unknown, urls: string[]): typeof fetch {
    return (async (url: string | URL) => {
      urls.push(String(url));
      expect(new URL(String(url)).pathname).toBe(path);
      const page = String(url).includes('cursor=') ? second : first;
      return new Response(JSON.stringify(page), { status: 200 });
    }) as typeof fetch;
  }

  test('projects: each with its slug and org, every page', async () => {
    const urls: string[] = [];
    const fetchImpl = paged(
      '/v1/projects',
      {
        data: [{ id: 'p-1', name: 'Staging', slug: 'acme-staging' }, { name: 'no id' }],
        hasMore: true,
        nextCursor: 'c2',
      },
      { data: [{ id: 'p-2', slug: 'acme-prod', orgId: 'org-a' }], hasMore: false },
      urls,
    );
    expect(
      await listProjectsReal({ endpoint: 'https://api.example.com', token: 'tok', fetchImpl }),
    ).toEqual({
      kind: 'ok',
      projects: [
        { id: 'p-1', name: 'Staging', slug: 'acme-staging' },
        { id: 'p-2', name: 'p-2', slug: 'acme-prod', orgId: 'org-a' },
      ],
    });
    expect(urls).toHaveLength(2);
  });

  test('orders: each entry with its position, and its project when the caller may read it', async () => {
    const urls: string[] = [];
    const fetchImpl = paged(
      '/v1/environment-orders',
      {
        data: [
          {
            parent: { kind: 'tenant' },
            entries: [
              { position: 0, projectId: 'p-1' },
              { position: 1 },
              { position: 'x', projectId: 'p-9' },
            ],
          },
        ],
        hasMore: true,
        nextCursor: 'c2',
      },
      { data: [{ parent: { kind: 'org' }, entries: [{ position: 0, projectId: 'p-3' }] }] },
      urls,
    );
    expect(
      await listEnvironmentOrdersReal({
        endpoint: 'https://api.example.com',
        token: 'tok',
        fetchImpl,
      }),
    ).toEqual({
      kind: 'ok',
      orders: [
        { entries: [{ position: 0, projectId: 'p-1' }, { position: 1 }] },
        { entries: [{ position: 0, projectId: 'p-3' }] },
      ],
    });
    expect(urls).toEqual([
      'https://api.example.com/v1/environment-orders?limit=100',
      'https://api.example.com/v1/environment-orders?limit=100&cursor=c2',
    ]);
  });

  test('orders: an error answer is an error', async () => {
    const refusing = (async () =>
      new Response(JSON.stringify({ error: { code: 'forbidden', message: 'no' } }), {
        status: 403,
      })) as unknown as typeof fetch;
    expect(
      await listEnvironmentOrdersReal({
        endpoint: 'https://api.example.com',
        token: 'tok',
        fetchImpl: refusing,
      }),
    ).toEqual({
      kind: 'error',
      message: 'GET https://api.example.com/v1/environment-orders answered HTTP 403 (forbidden)',
    });
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
