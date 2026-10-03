// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Barrel export for the reference in-memory adapters. Consumers wire
 * these into dev-time defaults + tests; production deployments supply
 * durable implementations of the same binding interfaces.
 */

export { makeInMemoryOrgBinding } from './org-binding.js';
export { makeInMemoryTeamBinding } from './team-binding.js';
export { makeInMemoryProjectBinding } from './project-binding.js';
