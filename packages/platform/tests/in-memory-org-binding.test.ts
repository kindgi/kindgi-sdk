// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire the shared `runOrgBindingConformance` suite against the
 * in-memory reference adapter.
 */

import { makeInMemoryOrgBinding } from '../src/in-memory/org-binding.js';
import { runOrgBindingConformance } from './org-binding.conformance.js';

runOrgBindingConformance(makeInMemoryOrgBinding, 'InMemoryOrgBinding');
