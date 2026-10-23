// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Kindgi runtime image `kindgi dev` runs. One place names
 * it, so a release pins the image it was tested with and a pull token
 * can drop in later. `--runtime-image` overrides it.
 *
 * Pinned by digest, not tag: Docker doesn't re-pull a tag it already has, so
 * a tag would leave anyone with an older pull on an older runtime.
 *
 * The image is on Quay. A pull credential (a robot name and a token) comes
 * from signing in with GitHub at access.kindgi.com (`KINDGI_ACCESS_ORIGIN`),
 * then `kindgi auth registry --username <name>`. On Kindgi's own registry
 * (`KINDGI_REGISTRY`), the license key from signing in there pulls it:
 * `kindgi auth registry` logs in with the key.
 */
export const DEFAULT_RUNTIME_IMAGE =
  'quay.io/kindgi/runtime:0.1.10@sha256:b6bdf6bcc6fb86fd1e16a2fce7d37dc066b766a0b4313dd3f19e2c904b3b01b3';

/** Docker Hub, the registry of a reference that names none (`busybox`, `library/busybox`). */
const DOCKER_HUB = 'docker.io';

/**
 * The registry an image reference is pulled from, read the way Docker
 * reads it: the first path component when it names a host (it has a `.`
 * or a `:`, or is `localhost`), otherwise Docker Hub.
 */
export function registryOf(image: string): string {
  const slash = image.indexOf('/');
  if (slash === -1) return DOCKER_HUB;
  const first = image.slice(0, slash);
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : DOCKER_HUB;
}

/** The registry `DEFAULT_RUNTIME_IMAGE` is pulled from: `kindgi auth registry` logs in to it. */
export const RUNTIME_IMAGE_REGISTRY = registryOf(DEFAULT_RUNTIME_IMAGE);

/**
 * Kindgi's own registry. It takes Basic auth with a license key as the
 * password: the username is ignored, and is `KINDGI_REGISTRY_USERNAME` by
 * convention.
 */
export const KINDGI_REGISTRY = 'registry.kindgi.com';

/** The username `kindgi auth registry` logs in to `KINDGI_REGISTRY` as. */
export const KINDGI_REGISTRY_USERNAME = 'kindgi';

/**
 * The same image on another registry: its repository path, tag and digest
 * under `registry`, the way a mirror carries it.
 */
export function imageOnRegistry(image: string, registry: string): string {
  const own = registryOf(image);
  if (own === registry) return image;
  const named = image.startsWith(`${own}/`);
  const path = named ? image.slice(own.length + 1) : image;
  // Docker Hub's official images live under `library/`.
  return `${registry}/${!named && !path.includes('/') ? `library/${path}` : path}`;
}
