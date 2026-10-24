// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * For tests: run with other bounds than the process's, then put them back.
 * Never in a server: its bounds are set once, at boot.
 */
export { overrideTenantInputBounds } from './bounds.js';
