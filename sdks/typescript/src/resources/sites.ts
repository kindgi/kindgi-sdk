// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Sites that sign their own people in to one project: a site (a WordPress
 * admin, say) vouches for whoever is signed in there, so they ask the
 * project's agents and decide its approvals as themselves.
 * `client.projects.sites` manages them (tenant admins); a site itself
 * calls `client.auth.enrollSite` and `client.auth.siteSignIn`.
 *
 * @wire /v1/projects/:projectId/sites, /v1/auth/sites/enroll, /v1/auth/site-sign-in
 * @generated Wire shapes from `../generated/api.js`.
 */

import type {
  EnrollSiteBody,
  EnrollSiteResult,
  RegisterSiteBody,
  RegisterSiteResult,
  Site,
  SiteCollectionPage,
  SiteEnrollmentCode,
  SiteKey,
  SitePersonRestoreResult,
  SiteRoleGrant,
  SiteSignInBody,
  SiteSignInResult,
  UpdateSiteBody,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type {
  EnrollSiteBody,
  EnrollSiteResult,
  RegisterSiteBody,
  RegisterSiteResult,
  Site,
  SiteCollectionPage,
  SiteEnrollmentCode,
  SiteKey,
  SitePersonRestoreResult,
  SiteRoleGrant,
  SiteSignInBody,
  SiteSignInResult,
  UpdateSiteBody,
};

type Idempotent = { readonly idempotencyKey?: string };

export interface SitesClient {
  /** @wire GET /v1/projects/:projectId/sites */
  list(
    projectId: string,
    filter?: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly includeUnregistered?: boolean;
    },
  ): Promise<SiteCollectionPage>;
  /**
   * The site, and its one-time enrollment code: give the code to the site,
   * which posts it with its public key.
   * @wire POST /v1/projects/:projectId/sites
   */
  register(
    projectId: string,
    body: RegisterSiteBody,
    options?: Idempotent,
  ): Promise<RegisterSiteResult>;
  /** @wire GET /v1/projects/:projectId/sites/:siteId */
  get(projectId: string, siteId: string): Promise<Site>;
  /** @wire PATCH /v1/projects/:projectId/sites/:siteId */
  update(
    projectId: string,
    siteId: string,
    body: UpdateSiteBody,
    options?: Idempotent,
  ): Promise<Site>;
  /** Stops the site's sign-ins, and ends its live sessions. @wire POST /v1/projects/:projectId/sites/:siteId/pause */
  pause(projectId: string, siteId: string, options?: Idempotent): Promise<Site>;
  /** @wire POST /v1/projects/:projectId/sites/:siteId/resume */
  resume(projectId: string, siteId: string, options?: Idempotent): Promise<Site>;
  /** @wire POST /v1/projects/:projectId/sites/:siteId/unregister */
  unregister(projectId: string, siteId: string, options?: Idempotent): Promise<Site>;
  /**
   * A new one-time code: the site's next key replaces every key it has, and
   * its live sessions end.
   * @wire POST /v1/projects/:projectId/sites/:siteId/enrollment-codes
   */
  newEnrollmentCode(
    projectId: string,
    siteId: string,
    options?: Idempotent,
  ): Promise<SiteEnrollmentCode>;
  /** @wire POST /v1/projects/:projectId/sites/:siteId/keys/:kid/revoke */
  revokeKey(projectId: string, siteId: string, kid: string, options?: Idempotent): Promise<Site>;
  /**
   * Let one of the site's people removed in Kindgi back in, while the site
   * still knows them: the same person, with their history. Their grants
   * come back the next time the site signs them in. Someone the site said
   * left stays gone: if they come back, it signs them in as a new person.
   * @wire POST /v1/projects/:projectId/sites/:siteId/people/:userId/restore
   */
  restorePerson(
    projectId: string,
    siteId: string,
    userId: string,
    options?: Idempotent,
  ): Promise<SitePersonRestoreResult>;
}

const seg = (s: string): string => encodeURIComponent(s);

export function makeSitesClient(transport: Transport): SitesClient {
  const key = (options?: Idempotent) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};
  return {
    list: (projectId, filter) =>
      transport.request<SiteCollectionPage>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/sites`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.includeUnregistered === true && { includeUnregistered: 'true' }),
        },
      }),
    register: (projectId, body, options) =>
      transport.request<RegisterSiteResult>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/sites`,
        body,
        ...key(options),
      }),
    get: (projectId, siteId) =>
      transport.request<Site>({
        method: 'GET',
        path: `/v1/projects/${seg(projectId)}/sites/${seg(siteId)}`,
      }),
    update: (projectId, siteId, body, options) =>
      transport.request<Site>({
        method: 'PATCH',
        path: `/v1/projects/${seg(projectId)}/sites/${seg(siteId)}`,
        body,
        ...key(options),
      }),
    pause: (projectId, siteId, options) =>
      transport.request<Site>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/sites/${seg(siteId)}/pause`,
        ...key(options),
      }),
    resume: (projectId, siteId, options) =>
      transport.request<Site>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/sites/${seg(siteId)}/resume`,
        ...key(options),
      }),
    unregister: (projectId, siteId, options) =>
      transport.request<Site>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/sites/${seg(siteId)}/unregister`,
        ...key(options),
      }),
    newEnrollmentCode: (projectId, siteId, options) =>
      transport.request<SiteEnrollmentCode>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/sites/${seg(siteId)}/enrollment-codes`,
        ...key(options),
      }),
    revokeKey: (projectId, siteId, kid, options) =>
      transport.request<Site>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/sites/${seg(siteId)}/keys/${seg(kid)}/revoke`,
        ...key(options),
      }),
    restorePerson: (projectId, siteId, userId, options) =>
      transport.request<SitePersonRestoreResult>({
        method: 'POST',
        path: `/v1/projects/${seg(projectId)}/sites/${seg(siteId)}/people/${seg(userId)}/restore`,
        ...key(options),
      }),
  };
}
