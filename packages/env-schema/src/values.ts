// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Value checks for variables whose shape the schema can't express.
 * Shared by the server, which reads them at startup, and the CLI, which
 * checks them before it starts anything: both refuse the same values
 * with the same message.
 */

/** The Ed25519 private key file that signs public run tokens. */
export const PUBLIC_TOKEN_KEY_PATH_VAR = 'KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH';

/** The same key's PEM file, base64: the alternative to the path. */
export const PUBLIC_TOKEN_KEY_VAR = 'KINDGI_PUBLIC_TOKEN_SIGNING_KEY';

/** The export signing key's PEM file (an absolute path), its base64 value, or a Cloud KMS key version: exactly one. */
export const EXPORT_SIGNING_KEY_PATH_VAR = 'KINDGI_EXPORT_SIGNING_KEY_PATH';
export const EXPORT_SIGNING_KEY_VAR = 'KINDGI_EXPORT_SIGNING_KEY';
export const EXPORT_SIGNING_KMS_KEY_VAR = 'KINDGI_EXPORT_SIGNING_KMS_KEY';

/** The license key the server checks at startup outside development mode. */
export const LICENSE_KEY_VAR = 'KINDGI_LICENSE_KEY';

/** The browser origins allowed on the routes a public run token opens. */
export const CORS_ORIGINS_VAR = 'KINDGI_CORS_ORIGINS';

/** The URL clients reach the runtime at, when it isn't the address it binds. */
export const PUBLIC_URL_VAR = 'KINDGI_PUBLIC_URL';

/** Sign-in with identity providers: the secret its browser flow signs with (a file). */
export const AUTH_SECRET_PATH_VAR = 'KINDGI_AUTH_SECRET_PATH';

/** The same secret, base64. */
export const AUTH_SECRET_VAR = 'KINDGI_AUTH_SECRET';

/** Identity provider origins on a private network the operator allows. */
export const AUTH_PRIVATE_IDP_ORIGINS_VAR = 'KINDGI_AUTH_PRIVATE_IDP_ORIGINS';

/** A browser session's absolute lifetime, in milliseconds. */
export const SESSION_TTL_MS_VAR = 'KINDGI_SESSION_TTL_MS';

/** How long a browser session may sit idle, in milliseconds. */
export const SESSION_IDLE_TIMEOUT_MS_VAR = 'KINDGI_SESSION_IDLE_TIMEOUT_MS';

/** The shared secret between the server and the pack service. */
export const PACK_SERVICE_TOKEN_VAR = 'KINDGI_PACK_SERVICE_TOKEN';

/**
 * `KINDGI_PACK_SERVICE_TOKEN` as both sides use it, without its
 * surrounding whitespace. The token travels in an HTTP header, which never
 * carries surrounding whitespace, so a secret stored with a trailing
 * newline (`openssl rand -hex 32 | gcloud secrets versions add …`) would
 * otherwise never match the one the other side compares it with. Unset or
 * blank: `undefined`. Throws on a token with whitespace, a control
 * character or a non-ASCII character inside, which a header can't carry.
 */
export function parsePackServiceToken(raw: string | undefined): string | undefined {
  const token = raw?.trim();
  if (token === undefined || token === '') return undefined;
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(
      `${PACK_SERVICE_TOKEN_VAR} may hold only printable ASCII without spaces (it travels in an HTTP header). Use a random value such as \`openssl rand -hex 32\`.`,
    );
  }
  return token;
}

/**
 * Parse `KINDGI_CORS_ORIGINS`: comma-separated exact origins
 * (`https://app.example.com`, `http://localhost:3000`): a scheme, a host
 * and an optional port; no path, no trailing slash, no wildcard. Unset or
 * empty: none. Throws on anything else, so a typo fails at startup rather
 * than as a browser's CORS error.
 */
export function parseCorsOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const invalid = origins.filter((origin) => !isExactOrigin(origin));
  if (invalid.length > 0) {
    throw new Error(
      `${CORS_ORIGINS_VAR} entries must be exact origins like https://app.example.com ` +
        `(scheme, host, optional port; no path or wildcard). Got: ${invalid.join(', ')}.`,
    );
  }
  return [...new Set(origins)];
}

/**
 * `KINDGI_PUBLIC_URL`: an `http(s)` URL with no credentials, query or
 * fragment, without a trailing slash; `undefined` when unset.
 */
export function parsePublicUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `${PUBLIC_URL_VAR} must be an http(s) URL like https://kindgi.example.com, with no credentials, query or fragment. Got: ${value}.`,
    );
  }
  return url.href.replace(/\/+$/, '');
}

function isExactOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // `https://*.example.com` parses (as a literal `*` host): refuse it.
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.origin === value &&
    !value.includes('*')
  );
}
