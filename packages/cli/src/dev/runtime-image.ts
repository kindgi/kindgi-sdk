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
 * The image is in private preview on Quay (pull credentials on request at
 * contact@kindgi.com, then `kindgi auth registry --username <name>`).
 */
export const DEFAULT_RUNTIME_IMAGE =
  'quay.io/kindgi/runtime:0.1.3@sha256:0a149b88696c4221355e0a5cb9de9609af020ec74cea145448bd22e928f259f3';

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
