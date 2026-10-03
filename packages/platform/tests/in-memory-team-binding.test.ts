// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire the shared `runTeamBindingConformance` suite against the
 * in-memory reference adapter.
 */

import { makeInMemoryTeamBinding } from '../src/in-memory/team-binding.js';
import { runTeamBindingConformance } from './team-binding.conformance.js';

runTeamBindingConformance(makeInMemoryTeamBinding, 'InMemoryTeamBinding');
