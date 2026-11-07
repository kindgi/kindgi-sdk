// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ProjectAttach,
  ProjectAttachIndexRevision,
  PutProjectAttachBody,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

/** An attach as the runtime keeps it, never with its route's token. */
export type { ProjectAttach };
/** One copy of an attach's index. */
export type { ProjectAttachIndexRevision };
export type ProjectAttachSpec = PutProjectAttachBody;

/**
 * A project's attaches, on a runtime serving many tenants: what sends the
 * runs a person starts with one key of theirs, limited to the project, to
 * their working copy of its code before it's deployed. Only a system key
 * holding `system:attaches` itself uses them; any other caller gets 403
 * (`system-principal-required`, `system-scope-missing`).
 */
export interface SystemAttachesClient {
  /**
   * Makes the attach, or refreshes its route and its route's token. Each
   * check names the person and key `spec` names: the route's host is on
   * the operator's list, the key is the person's own, live and limited to
   * the project, the person holds `admin` there, the project has no
   * production, and a person's own test project is this person's.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/projects/{projectId}/attaches/{attachId}`
   */
  put(
    tenantId: string,
    projectId: string,
    attachId: string,
    spec: ProjectAttachSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ProjectAttach>;
  /**
   * Copies the working copy's `index.json` in as the attach's newest
   * revision, checked as a deploy checks a pack's index: at most 1.5 MiB and
   * 2,000 primitives, and one copy every 2 seconds. The same copy as the
   * newest makes no new revision.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/projects/{projectId}/attaches/{attachId}/index`
   */
  putIndex(
    tenantId: string,
    projectId: string,
    attachId: string,
    index: Readonly<Record<string, unknown>>,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ProjectAttachIndexRevision>;
  /**
   * Ends the attach. Ending one that ended answers it as it is.
   *
   * @wire `DELETE /v1/system/tenants/{tenantId}/projects/{projectId}/attaches/{attachId}`
   */
  end(
    tenantId: string,
    projectId: string,
    attachId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ProjectAttach>;
}

export function makeSystemAttachesClient(transport: Transport): SystemAttachesClient {
  const seg = (s: string): string => encodeURIComponent(s);
  const key = (options?: { readonly idempotencyKey?: string }) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};
  return {
    async put(tenantId, projectId, attachId, spec, options) {
      return transport.request<ProjectAttach>({
        method: 'PUT',
        path: `/v1/system/tenants/${seg(tenantId)}/projects/${seg(projectId)}/attaches/${seg(attachId)}`,
        body: spec,
        ...key(options),
      });
    },
    async putIndex(tenantId, projectId, attachId, index, options) {
      return transport.request<ProjectAttachIndexRevision>({
        method: 'PUT',
        path: `/v1/system/tenants/${seg(tenantId)}/projects/${seg(projectId)}/attaches/${seg(attachId)}/index`,
        body: index,
        ...key(options),
      });
    },
    async end(tenantId, projectId, attachId, options) {
      return transport.request<ProjectAttach>({
        method: 'DELETE',
        path: `/v1/system/tenants/${seg(tenantId)}/projects/${seg(projectId)}/attaches/${seg(attachId)}`,
        ...key(options),
      });
    },
  };
}
