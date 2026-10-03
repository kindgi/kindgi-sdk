// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire the shared `runProjectBindingConformance` suite against the
 * in-memory reference adapter.
 */

import { makeInMemoryProjectBinding } from '../src/in-memory/project-binding.js';
import { runProjectBindingConformance } from './project-binding.conformance.js';

runProjectBindingConformance(makeInMemoryProjectBinding, 'InMemoryProjectBinding');
