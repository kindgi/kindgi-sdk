// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { renderResponse } from '../src/deploy/response.js';
import type { DeploymentRecord, PostDeploymentResult } from '../src/deploy/runners.js';

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

  test("a 429 it didn't wait out: the tenant's hour of image reads has its hint, another limit none", () => {
    const limited = (limit?: string): PostDeploymentResult => ({
      kind: 'wire-error',
      status: 429,
      retryAfterSeconds: 2400,
      error: {
        code: 'rate-limit-exceeded',
        message: 'Extract /app/index.json failed: try again in 40 min',
        ...(limit !== undefined && { limit }),
      },
    });
    expect(banner(limited('tenant-unpack-hour')).replaceAll(/\s+/g, ' ')).toContain(
      "This tenant's image reads unpacked as much as the server allows in an hour. Deploy again after the wait the message names",
    );
    for (const limit of ['schema-compile-time', 'constructor', undefined]) {
      expect(banner(limited(limit))).not.toContain('Hint:');
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

describe('renderResponse: a deploy that landed', () => {
  const record: DeploymentRecord = {
    deploymentId: 'd1',
    tenantId: 't1',
    imageRef: ctx.imageRef,
    imageDigest: 'sha256:4d18e69581b56a0c9f3e2b7d1c8a6f40e5b9d2c7',
    artifactVersion: ctx.artifactVersion,
    indexHash: ctx.indexHash,
    signerKeyId: 'k1',
    signerPublicKey: 'pk',
    signature: 'sig',
    publishedAt: '2026-10-30T08:00:00.000Z',
    activatedAt: '2026-10-30T08:00:01.000Z',
    primitives: { tools: 1, guardrails: 0, agents: 0, flows: 0 },
  };
  const perDeployment: DeploymentRecord = {
    ...record,
    endpoint: { status: 'pending', since: '2026-10-30T08:00:01.000Z' },
  };
  const landed = (kind: 'created' | 'replayed', r: DeploymentRecord): PostDeploymentResult =>
    kind === 'created' ? { kind, status: 201, record: r } : { kind, status: 200, record: r };

  test('with one pack service, runs in flight call the build it runs, as new runs do', () => {
    for (const kind of ['created', 'replayed'] as const) {
      const text = banner(landed(kind, record));
      expect(text).toContain(
        "With one pack service, runs already in flight call the build it runs, as new runs do: a tool version that build doesn't have fails at that tool with tool-version-mismatch.",
      );
      expect(text).not.toContain('pinned image');
      expect(text).not.toContain('keep their tool versions');
    }
  });

  test('routed per deployment (the record has a pack service), runs in flight keep their tool versions', () => {
    for (const kind of ['created', 'replayed'] as const) {
      const text = banner(landed(kind, perDeployment));
      expect(text).toContain(
        'Runs already in flight keep their tool versions: each tool call goes to the newest deployment that shipped the version it names.',
      );
      expect(text).not.toContain('pinned image');
      expect(text).not.toContain('With one pack service');
    }
  });

  test('a new deployment says what new runs use; a replay names the digest that landed before', () => {
    expect(banner(landed('created', record))).toContain(
      'Runs started from now use image sha256:4d18e69581b56… (artifactVersion 20261015.1).',
    );
    const replayed = banner(landed('replayed', record));
    expect(replayed).toContain(
      'Note: same imageDigest (sha256:4d18e69581b56…) previously landed. Server returned the existing record.',
    );
    expect(replayed).not.toContain('Deploy complete.');
  });
});
