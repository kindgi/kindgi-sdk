// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Promote-only builds: they reach a project in production only by
 * promotion. A build is promote-only when its signed envelope says
 * `productionEntry: 'promote-only'`, when the key that signed it has an id
 * starting with `PROMOTE_ONLY_KEY_PREFIX`, or when its public key is that
 * of such a key the workspace has ever trusted (a revoked entry is kept).
 * So trusting the same key again under another id never lifts it.
 *
 * Asked of one build by `POST /v1/deployments`, and of the builds
 * deployed into a project by `PUT /v1/projects/:projectId/production`.
 */

import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type { Deployment, DeploymentBinding } from '../deployment-binding.js';
import { PROMOTE_ONLY_KEY_PREFIX, type ProductionEntry } from '../deployment-envelope.js';
import type { SigningKeyBinding as SigningKeyRegistryBinding } from '../signing-key-binding.js';

/** What the question reads of a build. */
export interface PromoteOnlySigner {
  readonly productionEntry?: ProductionEntry;
  readonly signerKeyId: string;
  /** Base64 of the raw public-key bytes. */
  readonly publicKey: string;
}

type TrustList = Pick<SigningKeyRegistryBinding, 'listTrusted'>;

/**
 * A public key by its bytes, in one base64 spelling. The trust list keeps
 * a key as it was sent, padded or not, so two spellings of one key compare
 * equal only once decoded.
 */
function keyBytes(base64: string): string {
  return Buffer.from(base64, 'base64').toString('base64');
}

/** Promote-only by the build's own fields: its envelope's mark, or its key id's prefix. */
function markedByItsFields(build: PromoteOnlySigner): boolean {
  return (
    build.productionEntry === 'promote-only' ||
    build.signerKeyId.startsWith(PROMOTE_ONLY_KEY_PREFIX)
  );
}

/**
 * The public keys, by their bytes, of every key the workspace has trusted
 * under the prefix: every page of the list, revoked entries included.
 */
async function promoteOnlyPublicKeys(
  keys: TrustList,
  tenantId: TenantId,
): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  let cursor: Cursor | undefined;
  do {
    const page = await keys.listTrusted({
      tenantId,
      limit: 100,
      includeRevoked: true,
      ...(cursor !== undefined && { cursor }),
    });
    for (const key of page.data) {
      if ((key.keyId as unknown as string).startsWith(PROMOTE_ONLY_KEY_PREFIX)) {
        found.add(keyBytes(key.publicKey));
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found;
}

/** Whether one build is promote-only, reading the trust list only when its own fields don't say. */
export async function promoteOnlyBuild(
  keys: TrustList,
  tenantId: TenantId,
  build: PromoteOnlySigner,
): Promise<boolean> {
  if (markedByItsFields(build)) return true;
  return (await promoteOnlyPublicKeys(keys, tenantId)).has(keyBytes(build.publicKey));
}

/**
 * Whether a deployment was deployed into its project rather than promoted
 * there. A promotion needs `admin` on the project it enters, the press a
 * deploy's refusal sends one to, and a registration can't set
 * `promotedFromDeploymentId`. A binding that doesn't keep the field shows
 * every deployment as deployed.
 */
function deployedInto(deployment: Deployment): boolean {
  return deployment.promotedFromDeploymentId === undefined;
}

/**
 * The first deployment deployed into `projectId` (not promoted) that is
 * promote-only, or `undefined` when there's none: what keeps the project
 * out of production. Whether it still serves doesn't matter, since a build
 * out of service can be brought back. The trust list is read once, at the
 * first deployment whose own fields don't say.
 */
export async function promoteOnlyDeploymentIn(
  deployments: {
    readonly ledger: Pick<DeploymentBinding, 'list'>;
    readonly keys: TrustList;
  },
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<Deployment | undefined> {
  let prefixed: ReadonlySet<string> | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await deployments.ledger.list({
      tenantId,
      projectId,
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    for (const deployment of page.data) {
      if (!deployedInto(deployment)) continue;
      const build: PromoteOnlySigner = {
        ...(deployment.productionEntry !== undefined && {
          productionEntry: deployment.productionEntry,
        }),
        signerKeyId: deployment.signerKeyId as unknown as string,
        publicKey: deployment.signerPublicKey,
      };
      if (markedByItsFields(build)) return deployment;
      prefixed ??= await promoteOnlyPublicKeys(deployments.keys, tenantId);
      if (prefixed.has(keyBytes(build.publicKey))) return deployment;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}
