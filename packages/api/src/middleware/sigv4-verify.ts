// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * AWS Signature Version 4 verification for the `/s3/*` surface — pure
 * functions, no HTTP framework.
 *
 * Verification re-derives the signature from exactly what the client
 * signed:
 *
 *   - the timestamp the client signed with (`x-amz-date` header, or the
 *     `X-Amz-Date` query parameter of a presigned URL) — never the
 *     server's clock. The server's clock only bounds it: requests more
 *     than {@link MAX_CLOCK_SKEW_SECONDS} away are rejected
 *     (`RequestTimeTooSkewed`), presigned URLs past `X-Amz-Expires` are
 *     rejected (`AccessDenied`);
 *   - only the headers the client listed in `SignedHeaders`. Anything a
 *     proxy or HTTP stack adds after signing is ignored;
 *   - the canonical URI / query exactly as S3 defines them (path
 *     segments not normalized; query keys sorted, first value only).
 *
 * The signature comparison is constant-time.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** S3's allowed clock skew for signed requests (15 minutes). */
export const MAX_CLOCK_SKEW_SECONDS = 15 * 60;
/** S3's maximum presigned-URL lifetime (7 days). */
export const MAX_PRESIGN_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

const ALGORITHM = 'AWS4-HMAC-SHA256';
const AMZ_DATE = /^(\d{8})T\d{6}Z$/;
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface SigV4Error {
  /** S3 error code. */
  readonly code: string;
  readonly message: string;
  readonly status: 400 | 403;
}

export type SigV4Result<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly error: SigV4Error };

/** What a request claims about its signature, before verification. */
export interface SigV4Claim {
  readonly kind: 'header' | 'presigned';
  readonly accessKeyId: string;
  /** Credential-scope date, `YYYYMMDD`. */
  readonly scopeDate: string;
  readonly region: string;
  readonly service: string;
  /** Lowercase header names, as the client listed them. */
  readonly signedHeaders: readonly string[];
  readonly signature: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  readonly amzDate: string;
  /** Presigned only: `X-Amz-Expires`, seconds. */
  readonly expiresSeconds?: number;
}

export interface SigV4Request {
  readonly method: string;
  /** The request URL as received (pathname still percent-encoded). */
  readonly url: URL;
  readonly headers: Headers;
}

function err(code: string, message: string, status: 400 | 403): { kind: 'err'; error: SigV4Error } {
  return { kind: 'err', error: { code, message, status } };
}

/**
 * Parse the signature claim from the `Authorization` header or the
 * presigned-URL query parameters. Does not verify anything.
 */
export function parseSigV4(request: SigV4Request): SigV4Result<SigV4Claim> {
  const query = request.url.searchParams;
  const presignedAlgorithm = query.get('X-Amz-Algorithm');
  if (presignedAlgorithm !== null) {
    if (presignedAlgorithm !== ALGORITHM) {
      return err('InvalidRequest', `Unsupported presign algorithm "${presignedAlgorithm}"`, 403);
    }
    const credential = query.get('X-Amz-Credential');
    const signature = query.get('X-Amz-Signature');
    const amzDate = query.get('X-Amz-Date');
    const signedHeaders = query.get('X-Amz-SignedHeaders');
    const expires = query.get('X-Amz-Expires');
    if (credential === null || signature === null || amzDate === null || signedHeaders === null) {
      return err(
        'AuthorizationQueryParametersError',
        'Presigned URL must carry X-Amz-Credential, X-Amz-Date, X-Amz-SignedHeaders and X-Amz-Signature',
        400,
      );
    }
    const scope = parseCredentialScope(credential);
    if (scope === null) return err('InvalidRequest', 'Malformed X-Amz-Credential', 403);
    const expiresSeconds = expires === null ? MAX_PRESIGN_EXPIRES_SECONDS : Number(expires);
    if (
      !Number.isInteger(expiresSeconds) ||
      expiresSeconds < 1 ||
      expiresSeconds > MAX_PRESIGN_EXPIRES_SECONDS
    ) {
      return err(
        'AuthorizationQueryParametersError',
        `X-Amz-Expires must be an integer between 1 and ${MAX_PRESIGN_EXPIRES_SECONDS}`,
        400,
      );
    }
    return {
      kind: 'ok',
      value: {
        kind: 'presigned',
        ...scope,
        signedHeaders: signedHeaders.split(';'),
        signature,
        amzDate,
        expiresSeconds,
      },
    };
  }

  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.length === 0) return err('AccessDenied', 'Missing Authorization header', 403);
  const match = /^AWS4-HMAC-SHA256\s+(.+)$/i.exec(authorization);
  if (match === null) {
    return err('InvalidRequest', 'Only AWS4-HMAC-SHA256 signatures are supported', 403);
  }
  const fields = new Map<string, string>();
  for (const part of (match[1] as string).split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const credential = fields.get('Credential');
  const signedHeaders = fields.get('SignedHeaders');
  const signature = fields.get('Signature');
  if (credential === undefined || signedHeaders === undefined || signature === undefined) {
    return err(
      'InvalidRequest',
      'Malformed Authorization header (needs Credential, SignedHeaders, Signature)',
      403,
    );
  }
  const scope = parseCredentialScope(credential);
  if (scope === null) return err('InvalidRequest', 'Malformed credential scope', 403);
  const amzDate = request.headers.get('x-amz-date');
  if (amzDate === null) {
    return err('AccessDenied', 'Signed requests must carry an x-amz-date header', 403);
  }
  return {
    kind: 'ok',
    value: {
      kind: 'header',
      ...scope,
      signedHeaders: signedHeaders.split(';'),
      signature,
      amzDate,
    },
  };
}

/**
 * Check the claim's timestamp and shape against the server clock:
 * `X-Amz-Date` well-formed and consistent with the credential scope,
 * within {@link MAX_CLOCK_SKEW_SECONDS} (header auth / presigned not
 * dated in the future), and — presigned — not expired. Also checks the
 * signed-header list is sorted, lowercase, and covers what must be
 * signed.
 */
export function checkSigV4Claim(claim: SigV4Claim, now: Date): SigV4Result<void> {
  const dateMatch = AMZ_DATE.exec(claim.amzDate);
  if (dateMatch === null) {
    return err('AccessDenied', 'X-Amz-Date must be formatted as YYYYMMDDTHHMMSSZ', 403);
  }
  if (dateMatch[1] !== claim.scopeDate) {
    return err('SignatureDoesNotMatch', 'The credential scope date does not match X-Amz-Date', 403);
  }
  const signedAt = parseAmzDate(claim.amzDate);
  const skewSeconds = (now.getTime() - signedAt.getTime()) / 1000;
  if (skewSeconds < -MAX_CLOCK_SKEW_SECONDS) {
    return err(
      'RequestTimeTooSkewed',
      "The difference between the request time and the server's time is too large.",
      403,
    );
  }
  if (claim.kind === 'header' && skewSeconds > MAX_CLOCK_SKEW_SECONDS) {
    return err(
      'RequestTimeTooSkewed',
      "The difference between the request time and the server's time is too large.",
      403,
    );
  }
  if (claim.kind === 'presigned' && skewSeconds > (claim.expiresSeconds ?? 0)) {
    return err('AccessDenied', 'Request has expired', 403);
  }

  const sorted = [...claim.signedHeaders].sort();
  if (
    claim.signedHeaders.some((h, i) => h !== h.toLowerCase() || h !== sorted[i] || h === '') ||
    new Set(claim.signedHeaders).size !== claim.signedHeaders.length
  ) {
    return err('InvalidRequest', 'SignedHeaders must be lowercase, sorted and unique', 403);
  }
  const required =
    claim.kind === 'header' ? ['host', 'x-amz-content-sha256', 'x-amz-date'] : ['host'];
  const missing = required.filter((h) => !claim.signedHeaders.includes(h));
  if (missing.length > 0) {
    return err('AccessDenied', `SignedHeaders must include: ${missing.join(', ')}`, 403);
  }
  return { kind: 'ok', value: undefined };
}

/**
 * Re-derive the signature from exactly what the client signed and compare
 * it (constant-time) with the claimed one. `payloadHash` is the header
 * `x-amz-content-sha256` for header auth (the caller verifies it against
 * the body); presigned requests always sign `UNSIGNED-PAYLOAD`.
 */
export function verifySigV4Signature(
  request: SigV4Request,
  claim: SigV4Claim,
  secretKey: string,
): SigV4Result<void> {
  const canonical = canonicalRequest(request, claim);
  if (canonical.kind === 'err') return canonical;
  const scope = `${claim.scopeDate}/${claim.region}/${claim.service}/aws4_request`;
  const stringToSign = [ALGORITHM, claim.amzDate, scope, sha256Hex(canonical.value)].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, claim.scopeDate);
  const kRegion = hmac(kDate, claim.region);
  const kService = hmac(kRegion, claim.service);
  const kSigning = hmac(kService, 'aws4_request');
  const expected = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  if (!constantTimeEqual(expected, claim.signature.toLowerCase())) {
    return err(
      'SignatureDoesNotMatch',
      'The request signature we calculated does not match the signature you provided.',
      403,
    );
  }
  return { kind: 'ok', value: undefined };
}

/** The SigV4 canonical request (exported for tests). */
export function canonicalRequest(request: SigV4Request, claim: SigV4Claim): SigV4Result<string> {
  const headerLines: string[] = [];
  for (const name of claim.signedHeaders) {
    const value =
      name === 'host'
        ? (request.headers.get('host') ?? request.url.host)
        : request.headers.get(name);
    if (value === null) {
      return err(
        'SignatureDoesNotMatch',
        `Signed header "${name}" is missing from the request`,
        403,
      );
    }
    headerLines.push(`${name}:${value.trim().replace(/\s+/g, ' ')}`);
  }
  const payloadHash =
    claim.kind === 'presigned'
      ? UNSIGNED_PAYLOAD
      : (request.headers.get('x-amz-content-sha256') ?? UNSIGNED_PAYLOAD);
  return {
    kind: 'ok',
    value: [
      request.method.toUpperCase(),
      canonicalUri(request.url.pathname),
      canonicalQuery(request.url.search, claim.kind === 'presigned'),
      `${headerLines.join('\n')}\n`,
      claim.signedHeaders.join(';'),
      payloadHash,
    ].join('\n'),
  };
}

// -------------------- canonicalization (S3 rules) --------------------

/** RFC 3986 encoding: everything but unreserved characters. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Decode, tolerating stray `%` that is not a valid escape. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * S3 canonical URI: each path segment decoded, then RFC 3986-encoded;
 * segments are not normalized (`.` / `..` / `//` are significant for S3
 * keys) and an encoded slash stays a slash. `+` in the path is read as a
 * space, matching the common S3 signers.
 */
function canonicalUri(rawPath: string): string {
  if (rawPath === '' || rawPath === '/') return '/';
  const encoded = rawPath
    .split('/')
    .map((segment) => encodeRfc3986(safeDecode(segment.replace(/\+/g, ' '))))
    .join('/')
    .replace(/%2F/g, '/');
  return encoded.startsWith('/') ? encoded : `/${encoded}`;
}

/**
 * S3 canonical query: parameters decoded, re-encoded (RFC 3986), sorted
 * by key; for a repeated key only its first value counts. A presigned
 * URL's `X-Amz-Signature` is not part of what was signed.
 */
function canonicalQuery(rawSearch: string, presigned: boolean): string {
  const search = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  if (search === '') return '';
  const first = new Map<string, string>();
  for (const pair of search.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? '' : pair.slice(eq + 1);
    const key = safeDecode(rawKey.replace(/\+/g, ' '));
    if (key === '' || (presigned && key === 'X-Amz-Signature')) continue;
    const encodedKey = encodeRfc3986(key);
    if (!first.has(encodedKey)) {
      first.set(encodedKey, encodeRfc3986(safeDecode(rawValue.replace(/\+/g, ' '))));
    }
  }
  return [...first.keys()]
    .sort()
    .map((key) => `${key}=${first.get(key)}`)
    .join('&');
}

// -------------------- helpers --------------------

function parseCredentialScope(
  raw: string,
): { accessKeyId: string; scopeDate: string; region: string; service: string } | null {
  // <accessKeyId>/<YYYYMMDD>/<region>/<service>/aws4_request
  const parts = raw.split('/');
  if (parts.length !== 5 || parts[4] !== 'aws4_request') return null;
  const [accessKeyId, scopeDate, region, service] = parts as [string, string, string, string];
  if (accessKeyId === '' || !/^\d{8}$/.test(scopeDate) || region === '' || service === '')
    return null;
  return { accessKeyId, scopeDate, region, service };
}

function parseAmzDate(amzDate: string): Date {
  const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
  return new Date(iso);
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
