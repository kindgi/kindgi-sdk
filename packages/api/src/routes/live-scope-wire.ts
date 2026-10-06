// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LiveScope, OrgId, ProjectId } from '@kindgi/types';

import { parseSegmentsBody } from './segments.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A live scope on the wire: `{kind}` plus the id or path it needs. */
export type WireLiveScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'org'; readonly orgId: string }
  | { readonly kind: 'project'; readonly projectId: string }
  | {
      readonly kind: 'segment';
      readonly projectId: string;
      readonly path: readonly { readonly key: string; readonly value: string }[];
    };

export function liveScopeToWire(scope: LiveScope): WireLiveScope {
  switch (scope.kind) {
    case 'tenant':
      return { kind: 'tenant' };
    case 'org':
      return { kind: 'org', orgId: scope.orgId as unknown as string };
    case 'project':
      return { kind: 'project', projectId: scope.projectId as unknown as string };
    case 'segment':
      return {
        kind: 'segment',
        projectId: scope.projectId as unknown as string,
        path: scope.path.map(({ key, value }) => ({ key, value })),
      };
  }
}

/**
 * A live scope from a request body (`scope`): `{kind: 'tenant'}`,
 * `{kind: 'org', orgId}`, `{kind: 'project', projectId}` or
 * `{kind: 'segment', projectId, path: [{key, value}, …]}`.
 */
export function parseLiveScopeBody(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly scope: LiveScope }
  | { readonly kind: 'err'; readonly message: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const id = (field: 'orgId' | 'projectId'): string | undefined => {
    const v = b[field];
    return typeof v === 'string' && UUID_RE.test(v) ? v : undefined;
  };
  switch (b.kind) {
    case 'tenant':
      return { kind: 'ok', scope: { kind: 'tenant' } };
    case 'org': {
      const orgId = id('orgId');
      if (orgId === undefined)
        return { kind: 'err', message: '`scope.orgId` must be an org id (a UUID)' };
      return { kind: 'ok', scope: { kind: 'org', orgId: orgId as OrgId } };
    }
    case 'project': {
      const projectId = id('projectId');
      if (projectId === undefined) {
        return { kind: 'err', message: '`scope.projectId` must be a project id (a UUID)' };
      }
      return { kind: 'ok', scope: { kind: 'project', projectId: projectId as ProjectId } };
    }
    case 'segment': {
      const projectId = id('projectId');
      if (projectId === undefined) {
        return { kind: 'err', message: '`scope.projectId` must be a project id (a UUID)' };
      }
      const path = parseSegmentsBody(b.path, 'scope.path');
      if (path.kind === 'err') return path;
      if (path.segments === undefined) {
        return { kind: 'err', message: '`scope.path` needs at least one segment' };
      }
      return {
        kind: 'ok',
        scope: { kind: 'segment', projectId: projectId as ProjectId, path: path.segments },
      };
    }
    default:
      return {
        kind: 'err',
        message: '`scope.kind` must be one of tenant, org, project, segment',
      };
  }
}
