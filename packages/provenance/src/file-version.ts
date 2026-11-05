// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProvenanceNode } from './types.js';

/**
 * The file version an `artifact` node is, in its `attributes`, on a runtime
 * that keeps file versions: the file, the version and its name. The
 * version's sha256 is the node's own `contentHash`. A version a run made
 * and one it was given carry the same keys: only the node's edges tell
 * them apart.
 */
export interface FileVersionAttributes {
  readonly fileId: string;
  /** The version, from 1. */
  readonly fileVersion: number;
  /** The version's name. Absent: it has none. */
  readonly fileName?: string;
  /** On an update's node: the version it replaced. */
  readonly filePreviousVersion?: number;
}

/**
 * The file version an `artifact` node is, read from its `attributes`.
 * `undefined` for another kind of node, a node from before file versions,
 * or a `fileId` or `fileVersion` not of its shape. A `fileName` or
 * `filePreviousVersion` not of its shape is left out.
 */
export function fileVersionOf(node: ProvenanceNode): FileVersionAttributes | undefined {
  if (node.kind !== 'artifact') return undefined;
  const { fileId, fileVersion, fileName, filePreviousVersion } = node.attributes ?? {};
  if (typeof fileId !== 'string' || fileId.length === 0 || !isVersion(fileVersion)) {
    return undefined;
  }
  return {
    fileId,
    fileVersion,
    ...(typeof fileName === 'string' && { fileName }),
    ...(isVersion(filePreviousVersion) &&
      filePreviousVersion < fileVersion && { filePreviousVersion }),
  };
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
