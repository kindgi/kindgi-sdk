// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { OrgId, ProjectId } from './ids.js';

/**
 * One step of an app-defined finer scope, below a project: the app passes
 * them with a run as an ordered path from coarse to fine, e.g.
 * `company=acme` then `role=cfo`.
 */
export interface ScopeSegment {
  readonly key: string;
  readonly value: string;
}

/**
 * Where a live version is pinned, from least to most specific: the
 * agent's default for the tenant, an org, a project, or a segment path
 * within a project. A run takes the most specific pin that covers it; a
 * segment pin covers every run whose path starts with it.
 */
export type LiveScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'org'; readonly orgId: OrgId }
  | { readonly kind: 'project'; readonly projectId: ProjectId }
  | {
      readonly kind: 'segment';
      readonly projectId: ProjectId;
      readonly path: readonly ScopeSegment[];
    };

/**
 * Why a run used its agent version: named by the caller (`explicit`), held
 * by the flow version a flow's agent step runs in (`flow-pin`: its node's
 * `config.version`, else the version the flow version pinned when it was
 * published), the conversation's own (`conversation`), the version live
 * for the run's scope (`live`), or the latest registered, nothing being
 * live (`latest`).
 */
export type AgentVersionVia = 'explicit' | 'flow-pin' | 'conversation' | 'live' | 'latest';
