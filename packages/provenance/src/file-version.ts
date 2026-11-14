// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Timestamp } from '@kindgi/types';

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

/**
 * A file version a run took or made, as a record's builder is handed it, on
 * a runtime that keeps file versions. Each version is one `artifact` node,
 * whose edges say how the run came to it.
 */
export interface ProvenanceFileVersion {
  readonly fileId: string;
  /** The version, from 1. */
  readonly fileVersion: number;
  /** The version's name. Absent: it has none. */
  readonly fileName?: string;
  /**
   * The version's sha256, hex, as the files API answers it for the version:
   * the file's own, not a digest of a run's value.
   */
  readonly contentHash: string;
  /** On an update's version: the version it replaced. */
  readonly filePreviousVersion?: number;
  /**
   * `input`: the run's input named it. `made`: one of the run's calls added
   * it. `given`: a call was answered with a version another run or call
   * made (a conflict's Latest, or Latest for the same bytes).
   */
  readonly how: 'input' | 'made' | 'given';
  /** When the version was made, or when the run took it. */
  readonly at: Timestamp;
}

/** A record keeps at most this many file versions' nodes; one node counts the rest. */
export const MAX_FILE_VERSION_NODES = 1000;

/** A file version's node id: `file:<fileId>@v<version>`. */
export function fileVersionNodeId(fileId: string, fileVersion: number): string {
  return `file:${fileId}@v${String(fileVersion)}`;
}

/**
 * The record's nodes for a run's file versions, in the order given: one
 * `artifact` node per version, with `FileVersionAttributes` and the sha256
 * as its `contentHash`, the first entry's time its timestamp. An entry not
 * of its shape is left out. Past `MAX_FILE_VERSION_NODES` versions, the
 * rest are counted, not kept: `omitted` says how many, and `at` when the
 * first of them came. `kept` is each entry whose version has a node.
 */
export function fileVersionNodes<F extends ProvenanceFileVersion>(
  files: readonly F[],
): {
  readonly nodes: readonly ProvenanceNode[];
  readonly kept: readonly (F & { readonly nodeId: string })[];
  readonly omitted: number;
  readonly at?: Timestamp;
} {
  const nodes = new Map<string, ProvenanceNode>();
  const kept: (F & { readonly nodeId: string })[] = [];
  const omittedIds = new Set<string>();
  let at: Timestamp | undefined;
  for (const file of files) {
    if (!ofShape(file)) continue;
    const nodeId = fileVersionNodeId(file.fileId, file.fileVersion);
    if (!nodes.has(nodeId)) {
      if (nodes.size >= MAX_FILE_VERSION_NODES) {
        if (!omittedIds.has(nodeId)) at ??= file.at;
        omittedIds.add(nodeId);
        continue;
      }
      const attributes: FileVersionAttributes = {
        fileId: file.fileId,
        fileVersion: file.fileVersion,
        ...(typeof file.fileName === 'string' && { fileName: file.fileName }),
        ...(isVersion(file.filePreviousVersion) &&
          file.filePreviousVersion < file.fileVersion && {
            filePreviousVersion: file.filePreviousVersion,
          }),
      };
      nodes.set(nodeId, {
        id: nodeId,
        kind: 'artifact',
        timestamp: file.at,
        contentHash: file.contentHash,
        attributes: { ...attributes },
      });
    }
    kept.push({ ...file, nodeId });
  }
  return {
    nodes: [...nodes.values()],
    kept,
    omitted: omittedIds.size,
    ...(at !== undefined && { at }),
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function ofShape(file: ProvenanceFileVersion): boolean {
  return (
    typeof file.fileId === 'string' &&
    file.fileId.length > 0 &&
    isVersion(file.fileVersion) &&
    typeof file.contentHash === 'string' &&
    SHA256_HEX.test(file.contentHash) &&
    (file.how === 'input' || file.how === 'made' || file.how === 'given') &&
    typeof file.at === 'string'
  );
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
