// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Kindgi runtime image `kindgi dev` runs. One place names
 * it, so a release pins the image it was tested with and a pull token
 * can drop in later. `--runtime-image` overrides it.
 *
 * The image is private on Quay for now (robot-account pull credentials,
 * `docker login quay.io`); it goes public at the launch.
 */
export const DEFAULT_RUNTIME_IMAGE = 'quay.io/kindgi/runtime:preview';
