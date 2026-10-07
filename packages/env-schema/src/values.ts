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

/** The URL clients reach the runtime at, when it isn't the address it binds. */
export const PUBLIC_URL_VAR = 'KINDGI_PUBLIC_URL';

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

/** The Azure Key Vault key that wraps DEKs (postgres backend, KMS `azure`). */
export const AZURE_KEY_ID_VAR = 'KINDGI_SECRETS_AZURE_KEY_ID';

/** A Key Vault key, as `KINDGI_SECRETS_AZURE_KEY_ID` names it. */
export interface AzureKeyId {
  /** `https://<vault>.vault.azure.net/keys/<name>`, without a version or trailing slash. */
  readonly keyUrl: string;
  /** The vault's origin, `https://<vault>.vault.azure.net`. */
  readonly vaultUrl: string;
  readonly keyName: string;
}

/**
 * `KINDGI_SECRETS_AZURE_KEY_ID`: a Key Vault key's https URL **without a
 * version** (`https://<vault>.vault.azure.net/keys/<name>`, any Azure
 * cloud's vault or Managed HSM host). New DEKs are wrapped with the
 * key's current version, and each records the version it used, so a URL
 * pinned to one version is refused: it would outlive the key's rotation.
 * Unset or blank: `undefined`.
 */
export function parseAzureKeyId(raw: string | undefined): AzureKeyId | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const path = url?.pathname.match(/^\/keys\/([^/]+)(?:\/([^/]*))?\/?$/);
  if (
    url === undefined ||
    path === null ||
    path === undefined ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^[0-9A-Za-z-]{1,127}$/.test(path[1] ?? '')
  ) {
    throw new Error(
      `${AZURE_KEY_ID_VAR} must be a Key Vault key's URL without a version, like https://my-vault.vault.azure.net/keys/kindgi-secrets. Got: ${value}.`,
    );
  }
  const version = path[2];
  if (version !== undefined && version !== '') {
    throw new Error(
      `${AZURE_KEY_ID_VAR} names one version of the key (${version}). Give the key without it, ${url.origin}/keys/${path[1]}: new secrets are wrapped with the key's current version, so a pinned version would outlive the key's rotation.`,
    );
  }
  const keyName = path[1] as string;
  return { keyUrl: `${url.origin}/keys/${keyName}`, vaultUrl: url.origin, keyName };
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
