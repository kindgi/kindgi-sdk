// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire the shared `runTeamBindingConformance` suite against the
 * in-memory reference adapter.
 */

import { makeInMemoryTeamBinding } from '../src/in-memory/team-binding.js';
import { CONFORMANCE_MISSING_ORG, runTeamBindingConformance } from './team-binding.conformance.js';

runTeamBindingConformance(makeInMemoryTeamBinding, 'InMemoryTeamBinding');
// With an org check: every org but the missing one is the tenant's.
runTeamBindingConformance(
  () =>
    makeInMemoryTeamBinding({ orgExists: (_tenantId, orgId) => orgId !== CONFORMANCE_MISSING_ORG }),
  'InMemoryTeamBinding (checking orgs)',
  { checksOrgs: true },
);
