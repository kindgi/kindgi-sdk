// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { OrgId, ProjectId } from './ids.js';

/**
 * Where a secret an item names is read, as recorded on the item when it's
 * registered: the item's tenant itself, one of its orgs, or one of its
 * projects. The runtime reads the secret at that scope only.
 */
export type RecordedSecretScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'org'; readonly orgId: OrgId }
  | { readonly kind: 'project'; readonly projectId: ProjectId };
