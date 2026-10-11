// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';

/**
 * A digest-pinned image reference, split into the parts an allow-list
 * compares: `<host>/<path>@sha256:<hex>`. The host is lowercased (registry
 * hosts are case-insensitive); the path is already lowercase, as the
 * reference grammar requires; the digest is lowercased.
 */
export interface ImageRef {
  readonly host: string;
  readonly path: string;
  readonly digest: string;
}

/** A repository prefix an image must sit at or under: `<host>/<path>`. */
export interface ImagePrefix {
  readonly host: string;
  readonly path: string;
}

export interface ImageRefError {
  readonly code: 'image-ref-invalid';
  /** What's wrong with it, for the refusal's message. */
  readonly reason: string;
}

// The distribution reference grammar (OCI distribution-spec, Docker's
// `reference` package): a domain of dot-separated components with an
// optional port, then lowercase path components joined by `.`, `_`, `__`
// or dashes. A `..` segment, user info, or an uppercase path can't match.
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]+)?`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const NAME_RE = new RegExp(`^(${DOMAIN})/(${PATH_COMPONENT}(?:/${PATH_COMPONENT})*)$`);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
/** The grammar's limit on a repository name. */
const MAX_NAME_LENGTH = 255;

/**
 * Parse `<host>/<path>@sha256:<hex>`. The host must be written out (a
 * component with a dot or a port, or `localhost`), so `library/ubuntu`
 * never reads `library` as a registry. A tag, with or without the digest,
 * is refused: what's deployed is the digest, and a tag beside it could
 * say something else.
 */
export function parseImageRef(ref: string): Result<ImageRef, ImageRefError> {
  const at = ref.indexOf('@');
  if (at < 0) return invalid('it isn\'t digest-pinned: write "<host>/<repo>@sha256:<64-hex>"');
  if (ref.indexOf('@', at + 1) >= 0) return invalid('it has more than one "@"');
  const digest = ref.slice(at + 1);
  if (!DIGEST_RE.test(digest)) return invalid('its digest isn\'t "sha256:<64-hex>"');
  const name = parseName(ref.slice(0, at));
  if (name.kind === 'err') return name;
  return { kind: 'ok', value: { ...name.value, digest: digest.toLowerCase() } };
}

/** Parse a repository prefix, `<host>/<path>`, with no tag or digest. */
export function parseImagePrefix(prefix: string): Result<ImagePrefix, ImageRefError> {
  if (prefix.includes('@')) return invalid('a prefix has no digest');
  return parseName(prefix);
}

/**
 * Whether the image sits at the prefix or under it, on a path boundary:
 * `…/s-1` admits `…/s-1` and `…/s-1/agent`, never `…/s-10`.
 */
export function imageRefWithin(ref: ImageRef, prefix: ImagePrefix): boolean {
  return (
    ref.host === prefix.host && (ref.path === prefix.path || ref.path.startsWith(`${prefix.path}/`))
  );
}

/**
 * Whether two prefixes overlap: equal, or one at or under the other on a
 * path boundary. Two tenants' prefixes never may, or one could deploy the
 * other's images.
 */
export function imagePrefixesOverlap(a: ImagePrefix, b: ImagePrefix): boolean {
  if (a.host !== b.host) return false;
  return a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`);
}

function parseName(name: string): Result<ImagePrefix, ImageRefError> {
  if (name.length > MAX_NAME_LENGTH) {
    return invalid(`its repository is longer than ${MAX_NAME_LENGTH} characters`);
  }
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash >= 0 && name.slice(lastSlash + 1).includes(':')) {
    return invalid('it has a tag: name the image by its digest alone');
  }
  const match = NAME_RE.exec(name);
  if (match === null) {
    return invalid('it isn\'t "<host>/<repo>", with a lowercase repository path');
  }
  const host = (match[1] as string).toLowerCase();
  if (!host.includes('.') && !host.includes(':') && host !== 'localhost') {
    return invalid(`"${host}" isn't a registry host: write the registry out`);
  }
  return { kind: 'ok', value: { host, path: match[2] as string } };
}

function invalid(reason: string): { readonly kind: 'err'; readonly error: ImageRefError } {
  return { kind: 'err', error: { code: 'image-ref-invalid', reason } };
}
