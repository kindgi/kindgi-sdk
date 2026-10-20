// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  CreateSystemTenantBody,
  CreateSystemTenantResult,
  ProjectSuspension,
  SystemTenantList,
  SystemTenantPurge,
  SystemTenant as SystemTenantWire,
  TenantAdminContacts,
  TenantLimitsResult,
  TenantLimits as TenantLimitsWire,
  TenantProductionAllowed,
} from '../generated/api.js';
import type { Transport } from '../transport.js';
import type { RenameTenantInput } from './tenant.js';

export type TenantLimitsShape = TenantLimitsWire;
export type SystemTenant = SystemTenantWire;
export type SystemTenantSpec = CreateSystemTenantBody;
export type CreatedSystemTenant = CreateSystemTenantResult;
export type TenantAdminContact = TenantAdminContacts['data'][number];
export type TenantPurge = SystemTenantPurge;

/**
 * What the control plane sets on a tenant, with a system key (`kgi_sy_…`)
 * holding the route's scope. A tenant's own key gets 403
 * (`system-principal-required`); a key without the scope,
 * `system-scope-missing`. A closing tenant answers `409 tenant-closing`.
 */
export interface SystemTenantsClient {
  /**
   * Create a tenant, with its setup. With `firstAdmin`, that person is its
   * admin, and no key comes back; without it, its first admin key comes back
   * once (the full system capability only). Takes `system:tenants:create` or
   * `system:tenants`. Production starts blocked; `productionAllowed: true`
   * takes `system:tenants:production`, and `imagePrefix`
   * `system:tenants:image-prefix`.
   *
   * @wire `POST /v1/system/tenants`
   */
  create(
    spec: SystemTenantSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<CreatedSystemTenant>;
  /**
   * Tenants, newest first, purged ones left out. Takes `system:tenants`.
   *
   * @wire `GET /v1/system/tenants`
   */
  list(page?: { readonly limit?: number; readonly cursor?: string }): Promise<SystemTenantList>;
  /**
   * One tenant. Takes `system:tenants`.
   *
   * @wire `GET /v1/system/tenants/{tenantId}`
   */
  get(tenantId: string): Promise<SystemTenant>;
  /**
   * Rename a tenant: its name, its slug, or both, as its own admins can
   * with `tenant.update`. Its id stays. Takes `system:tenants`. Answers
   * nothing: `get()` reads it.
   *
   * @wire `PATCH /v1/system/tenants/{tenantId}`
   */
  update(
    tenantId: string,
    input: RenameTenantInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
  /**
   * Close the tenant: readable and exportable for its window, nothing runs.
   * One-way. Takes `system:tenants`.
   *
   * @wire `POST /v1/system/tenants/{tenantId}/close`
   */
  close(tenantId: string, options?: { readonly idempotencyKey?: string }): Promise<SystemTenant>;
  /**
   * Suspend the tenant (`true`), or restore it (`false`). Reversible. Takes
   * `system:suspend`.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/suspended`
   */
  setSuspended(
    tenantId: string,
    suspended: boolean,
    reason?: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<SystemTenant>;
  /**
   * The repository the tenant's deployments' images must sit in,
   * `<host>/<path>` with no trailing slash. Takes
   * `system:tenants:image-prefix`; changing one already set takes the full
   * system capability.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/image-prefix`
   */
  setImagePrefix(
    tenantId: string,
    prefix: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<SystemTenant>;
  /**
   * Suspend one of the tenant's projects (`true`), or restore it (`false`).
   * Takes `system:suspend`.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/projects/{projectId}/suspended`
   */
  setProjectSuspended(
    tenantId: string,
    projectId: string,
    suspended: boolean,
    reason?: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ProjectSuspension>;
  /**
   * The tenant's admins' contact addresses, for service notices. Takes
   * `system:tenants:contacts`.
   *
   * @wire `GET /v1/system/tenants/{tenantId}/admins`
   */
  admins(tenantId: string): Promise<readonly TenantAdminContact[]>;
  /**
   * Purge a closed tenant for good, once its export window has passed:
   * every row of it, its artifacts' bytes and its authorization store.
   * Irreversible. `confirm` is its slug, a second check on the id. It
   * answers when done; when `complete` is `false`, or the call ended before
   * its answer, run it again (a new request) to finish it. Takes its own
   * scope, `system:tenants:purge`.
   *
   * @wire `POST /v1/system/tenants/{tenantId}/purge`
   */
  purge(
    tenantId: string,
    confirm: string,
    options?: {
      readonly idempotencyKey?: string;
      /**
       * How long to wait for the answer, in milliseconds: this call's
       * `ClientOptions.timeoutMs`. The purge waits for every server to see
       * its mark before it answers, so a large tenant can take longer than
       * the client's default.
       */
      readonly timeoutMs?: number;
    },
  ): Promise<TenantPurge>;
  /**
   * Allow the tenant to put projects in production (`true`), or stop it
   * (`false`): the switch the production gate reads. Takes
   * `system:tenants:production`.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/production-allowed`
   */
  setProductionAllowed(
    tenantId: string,
    allowed: boolean,
    options?: { readonly idempotencyKey?: string },
  ): Promise<TenantProductionAllowed>;
  /**
   * The tenant's limits as stored, in the shape `setLimits` takes: to
   * change one, read them, change it and set them all. A limit that isn't
   * set is absent. Takes `system:tenants:limits`; a closing tenant's can
   * be read.
   *
   * @wire `GET /v1/system/tenants/{tenantId}/limits`
   */
  limits(tenantId: string): Promise<TenantLimitsResult>;
  /**
   * Replace the tenant's limits with exactly these: a limit left out isn't
   * set, and isn't enforced. Takes `system:tenants:limits`.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/limits`
   */
  setLimits(
    tenantId: string,
    limits: TenantLimitsShape,
    options?: { readonly idempotencyKey?: string },
  ): Promise<TenantLimitsResult>;
}

export function makeSystemTenantsClient(transport: Transport): SystemTenantsClient {
  const idem = (options?: { readonly idempotencyKey?: string }) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};
  return {
    async create(spec, options) {
      return transport.request<CreatedSystemTenant>({
        method: 'POST',
        path: '/v1/system/tenants',
        body: spec,
        ...idem(options),
      });
    },
    async list(page) {
      return transport.request<SystemTenantList>({
        method: 'GET',
        path: '/v1/system/tenants',
        query: {
          ...(page?.limit !== undefined && { limit: page.limit }),
          ...(page?.cursor !== undefined && { cursor: page.cursor }),
        },
      });
    },
    async get(tenantId) {
      return transport.request<SystemTenant>({
        method: 'GET',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}`,
      });
    },
    async update(tenantId, input, options) {
      return transport.request<void>({
        method: 'PATCH',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}`,
        body: input,
        ...idem(options),
      });
    },
    async close(tenantId, options) {
      return transport.request<SystemTenant>({
        method: 'POST',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/close`,
        body: {},
        ...idem(options),
      });
    },
    async setSuspended(tenantId, suspended, reason, options) {
      return transport.request<SystemTenant>({
        method: 'PUT',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/suspended`,
        body: { suspended, ...(reason !== undefined && { reason }) },
        ...idem(options),
      });
    },
    async setImagePrefix(tenantId, prefix, options) {
      return transport.request<SystemTenant>({
        method: 'PUT',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/image-prefix`,
        body: { prefix },
        ...idem(options),
      });
    },
    async setProjectSuspended(tenantId, projectId, suspended, reason, options) {
      return transport.request<ProjectSuspension>({
        method: 'PUT',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/projects/${encodeURIComponent(projectId)}/suspended`,
        body: { suspended, ...(reason !== undefined && { reason }) },
        ...idem(options),
      });
    },
    async admins(tenantId) {
      const page = await transport.request<TenantAdminContacts>({
        method: 'GET',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/admins`,
      });
      return page.data;
    },
    async purge(tenantId, confirm, options) {
      return transport.request<TenantPurge>({
        method: 'POST',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/purge`,
        body: { confirm },
        ...idem(options),
        ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      });
    },
    async setProductionAllowed(tenantId, allowed, options) {
      return transport.request<TenantProductionAllowed>({
        method: 'PUT',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/production-allowed`,
        body: { allowed },
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async limits(tenantId) {
      return transport.request<TenantLimitsResult>({
        method: 'GET',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/limits`,
      });
    },
    async setLimits(tenantId, limits, options) {
      return transport.request<TenantLimitsResult>({
        method: 'PUT',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/limits`,
        body: limits,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
