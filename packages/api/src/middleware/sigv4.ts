// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { S3CredentialBinding } from '../s3-credential-binding.js';
import type { AppEnv } from '../types.js';
import { errorXml } from '../xml.js';
import {
  type SigV4Claim,
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
 * signature → bucket → body → payload hash. The body is read once,
 * under `maxBytes`, and compared with the `x-amz-content-sha256` the
 * client signed; the routes read the copy Hono keeps.
 *
 * ## S3-style errors
 *
 * Failures return S3 error XML (not JSON): `AccessDenied`,
 * `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `RequestTimeTooSkewed`,
 * `XAmzContentSHA256Mismatch`, `AuthorizationQueryParametersError`,
 * `InvalidRequest`, and `EntityTooLarge` for a body over `maxBytes`.
 */
export function sigv4Middleware(
  binding: S3CredentialBinding,
  maxBytes: number,
): MiddlewareHandler<AppEnv> {
  const underLimit = objectBodyLimit(maxBytes);
  return async (c, next) => {
    const req = c.req.raw;
    const method = req.method;
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

    // ------------ signature ------------
    // Over the headers alone: the body is checked against the hash they declare, below.
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

    // ------------ body + payload hash verification ------------
    if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
      const refused = await readSignedBody(c, info, underLimit);
      if (refused !== undefined) return refused;
    }

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

/**
 * Reads the body once, under `underLimit`, and the refusal if it's over
 * it or doesn't match what was signed. Header auth signs
 * `x-amz-content-sha256`: the body's bytes are checked against it, an
 * empty body's too, or a body swapped or dropped after signing would
 * still verify. (Presigned URLs sign `UNSIGNED-PAYLOAD` by design.)
 */
async function readSignedBody(
  c: Context<AppEnv>,
  claim: SigV4Claim,
  underLimit: MiddlewareHandler<AppEnv>,
): Promise<Response | undefined> {
  const read: { body?: Uint8Array } = {};
  const refused = await underLimit(c, async () => {
    read.body = new Uint8Array(await c.req.arrayBuffer());
  });
  if (read.body === undefined) return refused as Response;
  const declared = claim.kind === 'header' ? (c.req.header('x-amz-content-sha256') ?? '') : '';
  if (declared === 'UNSIGNED-PAYLOAD' || declared.length === 0) return undefined;
  const actual = createHash('sha256').update(read.body).digest('hex');
  if (constantTimeEqual(actual, declared)) return undefined;
  return xmlError(
    c,
    'XAmzContentSHA256Mismatch',
    'The provided x-amz-content-sha256 header does not match the SHA256 of the request body.',
    400,
  );
}

/**
 * A body over `maxBytes` is S3's `400 EntityTooLarge`: refused unread by
 * its declared length, or as soon as a streamed one passes it.
 */
function objectBodyLimit(maxBytes: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      xmlError(
        c,
        'EntityTooLarge',
        `Your proposed upload exceeds the maximum allowed size of ${maxBytes} bytes`,
        400,
      ),
  });
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
