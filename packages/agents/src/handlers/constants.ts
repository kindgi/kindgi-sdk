// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Defaults shared across handler modules. Kept in a single tiny module
 * so the loop-body handlers can import them without pulling in the
 * whole invoke.ts orchestration surface.
 */
export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_MAX_WALL_MS = 120_000;
