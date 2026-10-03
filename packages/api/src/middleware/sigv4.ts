// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import type { S3CredentialBinding } from '../s3-credential-binding.js';
import type { AppEnv } from '../types.js';
import { errorXml } from '../xml.js';
import {
  checkSigV4Claim,
  constantTimeEqual,
  parseSigV4,
  verifySigV4Signature,
} from './sigv4-verify.js';

/**
 * AWS SigV4 verification middleware for the `/s3/*` wire surface.
 * Verifies both header-based auth (`Authorization: AWS4-HMAC-SHA256 ...`)
 * and presigned URLs (`?X-Amz-Algorithm=...&X-Amz-Signature=...`). On
 * success sets `tenantId`, `bucket` and `s3AccessKeyId` on the context for
 * downstream route handlers.
 *
 * The signature is re-derived from exactly what the client signed — its
 * own timestamp and only its `SignedHeaders` (see `./sigv4-verify.ts`);
 * the server clock only bounds the timestamp (±15 minutes; presigned URLs
 * until `X-Amz-Expires`). Order: parse → timestamp/scope → credential →
 * payload hash → signature → bucket.
 *
 * ## S3-style errors
 *
 * Failures return S3 error XML (not JSON): `AccessDenied`,
 * `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `RequestTimeTooSkewed`,
 * `XAmzContentSHA256Mismatch`, `AuthorizationQueryParametersError`,
 * `InvalidRequest`.
 */
export function sigv4Middleware(binding: S3CredentialBinding): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const req = c.req.raw;
    const method = req.method;
    // Read body once so both hash + downstream reads can access it.
    // The whole body is buffered — a limitation for large uploads; true
    // streaming would need to pass the raw stream through after a
    // header-only signature check.
    const bodyBytes =
      method === 'GET' || method === 'HEAD' || method === 'DELETE'
        ? Buffer.alloc(0)
        : Buffer.from(await req.arrayBuffer());

    const url = new URL(req.url);
    const request = { method, url, headers: req.headers };

    const claim = parseSigV4(request);
    if (claim.kind === 'err') {
      return xmlError(c, claim.error.code, claim.error.message, claim.error.status);
    }
    const info = claim.value;
    const checked = checkSigV4Claim(info, new Date());
    if (checked.kind === 'err') {
      return xmlError(c, checked.error.code, checked.error.message, checked.error.status);
    }

    const credential = await binding.resolve(info.accessKeyId);
    if (credential === null) {
      return xmlError(
        c,
        'InvalidAccessKeyId',
        `The AWS Access Key Id you provided does not exist: ${info.accessKeyId}`,
        403,
      );
    }
    if (credential.expiresAt !== undefined && credential.expiresAt.getTime() < Date.now()) {
      return xmlError(c, 'AccessDenied', 'Credential has expired', 403);
    }

    // ------------ payload hash verification ------------
    // Header auth signs `x-amz-content-sha256`. Cross-check it against
    // the actual body bytes, or an attacker could swap the body after
    // signing and the signature would still verify. (Presigned URLs sign
    // `UNSIGNED-PAYLOAD` by design.)
    if (info.kind === 'header' && bodyBytes.length > 0) {
      const declared = c.req.header('x-amz-content-sha256') ?? '';
      if (declared !== 'UNSIGNED-PAYLOAD' && declared.length > 0) {
        const actual = createHash('sha256').update(bodyBytes).digest('hex');
        if (!constantTimeEqual(actual, declared)) {
          return xmlError(
            c,
            'XAmzContentSHA256Mismatch',
            'The provided x-amz-content-sha256 header does not match the SHA256 of the request body.',
            400,
          );
        }
      }
    }

    // ------------ signature ------------
    const verified = verifySigV4Signature(request, info, credential.secretKey);
    if (verified.kind === 'err') {
      return xmlError(c, verified.error.code, verified.error.message, verified.error.status);
    }

    // ------------ bucket authorization ------------
    // Extract bucket from URL. /s3/<bucket>/<key>. The router mounts
    // this middleware under /s3, so the first path segment after
    // stripping the mount is the bucket.
    const requestedBucket = extractBucket(url.pathname);
    if (requestedBucket === null) {
      return xmlError(c, 'InvalidRequest', 'Bucket path segment missing', 400);
    }
    if (requestedBucket !== credential.bucket) {
      return xmlError(
        c,
        'AccessDenied',
        `Credential is not authorized for bucket "${requestedBucket}"`,
        403,
      );
    }

    // Buffer the body onto the request for downstream handlers to
    // re-consume. Hono's Context re-reads req.raw for each parse.
    rebindBody(c, bodyBytes);

    c.set('tenantId', credential.tenantId);
    c.set('bucket', credential.bucket);
    c.set('s3AccessKeyId', info.accessKeyId);
    await next();
    return;
  };
}

function extractBucket(pathname: string): string | null {
  // pathname like /s3/<bucket>/<key/with/slashes>. Middleware is
  // mounted at /s3, so req.url still shows the full pathname.
  const match = /^\/s3\/([^/?]+)/.exec(pathname);
  return match === null ? null : (match[1] as string);
}

// -------------------- comparison + rebind helpers --------------------

function rebindBody(c: { req: { raw: Request } }, body: Buffer): void {
  const original = c.req.raw;
  const rebuilt = new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
    // `duplex: 'half'` is required by undici when a body is present.
    ...(body.length > 0 && { duplex: 'half' }),
  } as RequestInit);
  Object.defineProperty(c.req, 'raw', { value: rebuilt, configurable: true });
}

// -------------------- XML error response --------------------

async function xmlError(
  c: import('hono').Context,
  code: string,
  message: string,
  status: number,
): Promise<Response> {
  const xml = errorXml(code, message);
  return c.body(xml, status as never, {
    'Content-Type': 'application/xml',
  });
}
