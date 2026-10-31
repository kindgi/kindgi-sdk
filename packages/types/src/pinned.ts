// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { OrgId, ProjectId } from './ids.js';

/** The items whose versions are pinned per scope (an agent's are its pinned versions, `AgentPinScope`). */
export type PinnedItemKind = 'flow' | 'tool';

/**
 * Where a flow or tool version is pinned, from least to most specific: the
 * tenant, an org, or a project. The most specific pin that covers a
 * project is the one in use there when nothing names a version. Flows and
 * tools pin no finer than a project.
 */
export type PinScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'org'; readonly orgId: OrgId }
  | { readonly kind: 'project'; readonly projectId: ProjectId };

/**
 * Why a run used its flow version: named by the caller (`explicit`), the
 * version pinned for the run's project (`pinned`), or the newest version
 * the project reaches, nothing being pinned for it (`latest`).
 */
export type FlowVersionVia = 'explicit' | 'pinned' | 'latest';
