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

/** The license key the server checks at startup outside development mode. */
export const LICENSE_KEY_VAR = 'KINDGI_LICENSE_KEY';

/** The browser origins allowed on the routes a public run token opens. */
export const CORS_ORIGINS_VAR = 'KINDGI_CORS_ORIGINS';

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
