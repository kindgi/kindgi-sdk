// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { renderResponse } from '../src/deploy/response.js';
import type { PostDeploymentResult } from '../src/deploy/runners.js';

const ctx = {
  envName: 'staging',
  endpoint: 'https://api.example.com',
  imageRef: 'registry.example.com/acme/pack@sha256:abc',
  artifactVersion: '20261015.1',
  indexHash: 'sha256:def',
  indexCounts: { tools: 1, guardrails: 0, agents: 0, flows: 0 },
  signerKeyId: 'k1',
  envelopePath: '.kindgi/build/envelope.json',
  idempotencyKey: 'k1',
};

const refused = (error: {
  code: string;
  message: string;
  cause?: string;
  limit?: string;
  details?: readonly Record<string, unknown>[];
}): PostDeploymentResult => ({ kind: 'wire-error', status: 400, error });

const banner = (result: PostDeploymentResult) => renderResponse(result, ctx).banner.join('\n');

describe('renderResponse: a refused deploy', () => {
  test("image-unverifiable's hint follows its cause, and the cause is shown", () => {
    const cases: readonly [cause: string | undefined, limit: string | undefined, says: string][] = [
      ['image-registry-unreachable', undefined, "couldn't reach the image's registry"],
      ['image-registry-unauthorized', undefined, "refused the runtime's credentials"],
      ['image-unreadable', undefined, "isn't an archive the server can read"],
      ['image-limit-exceeded', 'unpack', 'The same image is refused again'],
      ['image-limit-exceeded', 'tenant-unpack-hour', 'Deploy again after the wait'],
      // The bound on /app/index.json itself: a smaller image wouldn't help.
      ['image-limit-exceeded', 'file', 'make the largest schemas smaller'],
      // A limit beside another cause: that cause's hint.
      ['image-registry-unreachable', 'file', "couldn't reach the image's registry"],
      // A cause without a hint of its own, or none at all: the code's hint.
      ['image-file-not-found', undefined, 'could not pull the image'],
      ['constructor', undefined, 'could not pull the image'],
      [undefined, undefined, 'could not pull the image'],
    ];
    for (const [cause, limit, says] of cases) {
      const text = banner(
        refused({
          code: 'image-unverifiable',
          message: 'x',
          ...(cause !== undefined && { cause }),
          ...(limit !== undefined && { limit }),
        }),
      );
      expect(text.replaceAll(/\s+/g, ' ')).toContain(says);
      if (cause !== undefined) expect(text).toContain(`cause:   ${cause}`);
      else expect(text).not.toContain('cause:');
    }
  });

  test('a code like `constructor` has no hint', () => {
    expect(banner(refused({ code: 'constructor', message: 'x' }))).not.toContain('Hint:');
  });

  test("another code's hint doesn't follow a cause", () => {
    const text = banner(refused({ code: 'bad-input', message: 'x', cause: 'image-unreadable' }));
    expect(text.replaceAll(/\s+/g, ' ')).toContain('The wire body was malformed');
  });

  test("a validation refusal's issues are listed", () => {
    const text = banner(
      refused({
        code: 'deployment-validation-failed',
        message: 'x',
        details: [{ primitive: 'tool', index: 0, message: 'bad schema' }],
      }),
    );
    expect(text).toContain('Details:');
    expect(text).toContain('"primitive":"tool"');
  });
});
