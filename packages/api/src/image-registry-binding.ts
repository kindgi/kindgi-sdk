// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the OCI image registry — the "Docker
 * Registry HTTP API v2 client" seam used by the deploy route's
 * image-verifiability step. Mirrors the caller-plugged pattern of
 * `BlobStorageBinding`: the API package does NOT own registry auth or
 * connectivity. Deployments plug in an adapter that talks to whichever
 * OCI registry they run — hosted or self-hosted — using the credentials
 * they operate.
 *
 * Three ops per the OCI Distribution Spec:
 *   - `head`         — read manifest metadata (digest, config, layer
 *                      digests, size) without pulling bytes. Used at
 *                      `POST /v1/deployments` to verify the pinned
 *                      digest exists + matches what the deployer signed.
 *   - `extractFile`  — pull the bytes of a single file inside the image
 *                      (typically `/app/index.json`) without downloading
 *                      every layer. Used by the deploy route to verify
 *                      `indexHash` matches `sha256(image's index.json)`.
 *   - `push`         — upload a locally-built image + tag. Used by an
 *                      image build step; the API only reads.
 *
 * Each method is tenant-scoped so multi-tenant deployments can route
 * different tenants at different registries (or the same registry with
 * per-tenant credentials).
 *
 * ## Seam only
 *
 * No concrete implementation is bundled; the `POST /v1/deployments`
 * route calls `head` + `extractFile` through this interface.
 */
export interface ImageRegistryBinding {
  /**
   * Read the OCI image manifest for a digest-pinned reference. Returns
   * `image-not-found` when the registry has no manifest at the given
   * digest; `image-registry-unreachable` on transport / auth failure.
   *
   * The route MUST verify that `descriptor.digest` matches the digest
   * inside `input.imageRef` — the binding is not responsible for that
   * cross-check (defense-in-depth against a compromised registry).
   */
  head(input: ImageHeadInput): Promise<Result<ImageDescriptor, ImageRegistryError>>;
  /**
   * Fetch the bytes of a single file inside the image's layered
   * filesystem. Implementations stream from the highest layer that
   * contains the path — e.g. traverse layers top-down and return the
   * first hit. `bytes` is streamed as a
   * `Uint8Array` (small files only — `/app/index.json` is expected to
   * be a few kilobytes to low megabytes).
   *
   * Returns `image-file-not-found` when no layer contains the path,
   * `image-not-found` when the ref itself is unresolvable.
   */
  extractFile(input: ImageExtractFileInput): Promise<Result<ImageFile, ImageRegistryError>>;
  /**
   * Push a locally-built image + tag. Used by the build service, not by
   * the API — but the interface exposes it so the same binding
   * satisfies both consumers (a single deployment operator can wire one
   * adapter across the whole framework).
   *
   * `bytes` is an OCI image archive (`docker save`-compatible tarball
   * or a streaming OCI layout). The binding walks it, uploads each
   * blob + manifest, and tags the final digest. Returns the resolved
   * digest-pinned reference for the caller to sign over.
   */
  push(input: ImagePushInput): Promise<Result<ImagePushOutcome, ImageRegistryError>>;
}

// -------------------- descriptor --------------------

/**
 * Slice of the OCI manifest the API layer + build service need. Keeps
 * the interface stable against future spec revisions — bindings extract
 * the parts every consumer cares about and hide the rest.
 */
export interface ImageDescriptor {
  /** `sha256:<hex>` — canonical image digest, matches `imageRef`. */
  readonly digest: string;
  /** OCI media type of the manifest (`application/vnd.oci.image.manifest.v1+json` etc.). */
  readonly mediaType: string;
  /** Total on-wire size in bytes across all layers + config. */
  readonly size: number;
  /** Layer descriptors, top-to-bottom (the order used at pull time). */
  readonly layers: readonly ImageLayerDescriptor[];
  /** Image config descriptor (histories, env, entrypoint, etc.). */
  readonly config: ImageBlobDescriptor;
  /** `platform` from the manifest (e.g. `linux/amd64`). */
  readonly platform?: ImagePlatform;
}

export interface ImageLayerDescriptor {
  readonly digest: string;
  readonly mediaType: string;
  readonly size: number;
}

export type ImageBlobDescriptor = ImageLayerDescriptor;

export interface ImagePlatform {
  readonly os: string;
  readonly architecture: string;
  readonly variant?: string;
}

// -------------------- head --------------------

export interface ImageHeadInput {
  readonly tenantId: TenantId;
  /** Full digest-pinned reference: `<host>/<repo>@sha256:<hex>`. */
  readonly imageRef: string;
}

// -------------------- extractFile --------------------

export interface ImageExtractFileInput {
  readonly tenantId: TenantId;
  readonly imageRef: string;
  /**
   * Absolute path inside the image's layered filesystem. Convention:
   * leading slash + POSIX separators (`/app/index.json`).
   */
  readonly path: string;
}

export interface ImageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** `sha256` hex, lowercase — computed over `bytes` by the binding. */
  readonly sha256: string;
  /** Layer digest the file was found in — useful for audit logs. */
  readonly layerDigest: string;
}

// -------------------- push --------------------

export interface ImagePushInput {
  readonly tenantId: TenantId;
  /**
   * Unresolved reference the pusher requests — usually
   * `<host>/<repo>:<tag>`. The binding uploads the archive and returns
   * the digest-pinned form on success.
   */
  readonly imageRef: string;
  /** OCI image archive bytes. */
  readonly bytes: ReadableStream<Uint8Array> | Uint8Array;
  /** Optional annotations the binding forwards to the registry. */
  readonly annotations?: Readonly<Record<string, string>>;
}

export interface ImagePushOutcome {
  /** Digest-pinned reference the caller signs against. */
  readonly imageRef: string;
  readonly digest: string;
  readonly size: number;
}

// -------------------- error --------------------

/**
 * Discriminated error union. The deploy route reports any of these as
 * `400 image-unverifiable` ("we could not verify this image"), carrying
 * the binding's `code` as `cause`.
 */
export type ImageRegistryError =
  | {
      readonly code: 'image-not-found';
      readonly message: string;
      readonly imageRef: string;
    }
  | {
      readonly code: 'image-file-not-found';
      readonly message: string;
      readonly imageRef: string;
      readonly path: string;
    }
  | {
      readonly code: 'image-registry-unreachable';
      readonly message: string;
      readonly cause?: unknown;
    }
  | {
      readonly code: 'image-registry-unauthorized';
      readonly message: string;
    }
  | {
      readonly code: 'image-push-failed';
      readonly message: string;
      readonly cause?: unknown;
    };
