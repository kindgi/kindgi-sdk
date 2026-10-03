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
 * contact@kindgi.com, then `docker login quay.io`).
 */
export const DEFAULT_RUNTIME_IMAGE =
  'quay.io/kindgi/runtime:0.1.0@sha256:91cb164f17c0754d56d6f09783dad00748eff3e9906bdd3f49f45747cf49c5b2';
