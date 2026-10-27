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
 * The image is on Kindgi's registry, registry.kindgi.com. The license key
 * from signing in at access.kindgi.com (`KINDGI_ACCESS_ORIGIN`) is the
 * password: `docker login registry.kindgi.com --username kindgi`.
 */
export const DEFAULT_RUNTIME_IMAGE =
  'registry.kindgi.com/kindgi/runtime:0.2.0-rc.1@sha256:2bb8d06b545fde8e3da47c0dffcfa55000e3b042174ad51c13fcabac63de00fb';

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

/** Whether `host` is `KINDGI_REGISTRY`, in any case: a hostname is case-insensitive. */
export function isKindgiRegistry(host: string): boolean {
  return host.toLowerCase() === KINDGI_REGISTRY;
}

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
