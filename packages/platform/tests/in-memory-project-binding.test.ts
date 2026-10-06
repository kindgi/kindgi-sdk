// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire the shared `runProjectBindingConformance` suite against the
 * in-memory reference adapter.
 */

import { makeInMemoryProjectBinding } from '../src/in-memory/project-binding.js';
import {
  CONFORMANCE_MISSING_ORG,
  runProjectBindingConformance,
} from './project-binding.conformance.js';

runProjectBindingConformance(makeInMemoryProjectBinding, 'InMemoryProjectBinding');
// With an org check: every org but the missing one is the tenant's.
runProjectBindingConformance(
  () =>
    makeInMemoryProjectBinding({
      orgExists: (_tenantId, orgId) => orgId !== CONFORMANCE_MISSING_ORG,
    }),
  'InMemoryProjectBinding (checking orgs)',
  { checksOrgs: true },
);
