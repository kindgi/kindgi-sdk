// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { postDeploymentReal } from '../src/deploy/post.js';
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
});
