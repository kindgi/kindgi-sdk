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
 * The image is in private preview on Quay: pull credentials come from
 * RUNTIME_ACCESS_URL, then `kindgi auth registry --username <name>`.
 */
/**
 * Where pull credentials for the runtime image come from: signing in there
 * with GitHub gives a robot name and a token (and a non-production key).
 * The one place every message gets it.
 */
export const RUNTIME_ACCESS_URL = 'https://access.kindgi.com';

export const DEFAULT_RUNTIME_IMAGE =
  'quay.io/kindgi/runtime:0.1.5-rc.0@sha256:1b0bb6e5bb596753a92aa1289401c11a22045e259755bd23bf5367bc4f08209f';

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
