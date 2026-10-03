// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Filter, PackId, Page } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { Transport } from '../transport.js';
import type {
  InstallationId,
  InstalledPack,
  Pack,
  PackInstallInput,
  PackInstallStatus,
} from '../types.js';

/**
 * Packs resource — installable vertical applications.
 *
 * A pack bundles agents, tools, guardrails and memory schemas for
 * installation into a tenant.
 *
 * **Every method throws `not-yet-wired`.** The API has no pack routes
 * (there is no `packages/api/src/routes/packs.ts`) and `openapi.json`
 * has no `Pack` / `InstalledPack` / `PackInstallInput` schemas; these
 * shapes are defined by the SDK.
 */
export interface PacksClient {
  /**
   * @unwired No `POST /v1/packs` route.
   *
   * @example
   * ```ts
   * const installationId = await client.packs.install({
   *   kind: 'bundle',
   *   manifest: JSON.parse(fs.readFileSync('acme.pack.json', 'utf-8')),
   *   config: { firmName: 'Acme LLP', jurisdiction: 'US-NY' },
   * });
   * ```
   */
  install(input: PackInstallInput): Promise<InstallationId>;

  /** @unwired No `GET /v1/packs/installed` route. */
  installed(filter?: PackFilter): Promise<Page<InstalledPack>>;

  /** @unwired No `GET /v1/packs/{id}` route. */
  get(id: PackId): Promise<Pack>;

  /** @unwired No `GET /v1/packs/{id}/versions` route. */
  versions(id: PackId): Promise<Page<Pack>>;

  /** @unwired No `PATCH /v1/pack-installations/{id}/config` route. */
  configure(id: InstallationId, config: Readonly<Record<string, unknown>>): Promise<void>;

  /** @unwired No `POST /v1/pack-installations/{id}/disable` route. */
  disable(id: InstallationId): Promise<void>;

  /** @unwired No `POST /v1/pack-installations/{id}/enable` route. */
  enable(id: InstallationId): Promise<void>;

  /** @unwired No `POST /v1/pack-installations/{id}/upgrade` route. */
  upgrade(id: InstallationId, newVersion: string): Promise<void>;

  /** @unwired No `POST /v1/pack-installations/{id}/uninstall` route. */
  uninstall(id: InstallationId): Promise<void>;

  readonly registry: RegistryClient;
}

/**
 * @unwired Pack registry browsing — no API routes.
 */
export interface RegistryClient {
  /** @unwired No `GET /v1/packs/registry` route. */
  browse(filter?: RegistryFilter): Promise<Page<Pack>>;
  /** @unwired No `GET /v1/packs/registry/configured` route. */
  configured(): Promise<Page<{ readonly url: string; readonly name: string }>>;
}

export interface PackFilter extends Filter<PackInstallStatus> {
  readonly vendor?: string;
}

export interface RegistryFilter extends Filter {
  readonly vendor?: string;
  readonly queryText?: string;
}

const REASON_NO_PACK_API =
  'the API has no pack routes or wire schemas (Pack / InstalledPack / PackInstallInput) yet';

export function makePacksClient(_transport: Transport): PacksClient {
  return {
    async install(_input) {
      throw new KindgiApiError(notYetWired('packs.install', REASON_NO_PACK_API));
    },
    async installed(_filter) {
      throw new KindgiApiError(notYetWired('packs.installed', REASON_NO_PACK_API));
    },
    async get(_id) {
      throw new KindgiApiError(notYetWired('packs.get', REASON_NO_PACK_API));
    },
    async versions(_id) {
      throw new KindgiApiError(notYetWired('packs.versions', REASON_NO_PACK_API));
    },
    async configure(_id, _config) {
      throw new KindgiApiError(notYetWired('packs.configure', REASON_NO_PACK_API));
    },
    async disable(_id) {
      throw new KindgiApiError(notYetWired('packs.disable', REASON_NO_PACK_API));
    },
    async enable(_id) {
      throw new KindgiApiError(notYetWired('packs.enable', REASON_NO_PACK_API));
    },
    async upgrade(_id, _newVersion) {
      throw new KindgiApiError(notYetWired('packs.upgrade', REASON_NO_PACK_API));
    },
    async uninstall(_id) {
      throw new KindgiApiError(notYetWired('packs.uninstall', REASON_NO_PACK_API));
    },
    registry: {
      async browse(_filter) {
        throw new KindgiApiError(
          notYetWired(
            'packs.registry.browse',
            'v2 pack registry (public + private catalog federation) builds on the pack authoring API — not implemented yet',
          ),
        );
      },
      async configured() {
        throw new KindgiApiError(
          notYetWired(
            'packs.registry.configured',
            'v2 pack registry (public + private catalog federation) builds on the pack authoring API — not implemented yet',
          ),
        );
      },
    },
  };
}
