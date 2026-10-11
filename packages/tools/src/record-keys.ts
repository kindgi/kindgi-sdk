// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The `NodeContext.record` key a tool call's own `ToolContext.record(key, …)`
 * is journaled under, as the dispatch site sets it:
 *
 *   - an agent turn's call: `tool-call:<call id>:<tool id>:<key>` (call ids
 *     are unique only by provider convention, so the tool id keeps two
 *     tools apart);
 *   - a flow's tool step: `tool-call:<tool id>:<key>`, in its node's scope
 *     (already per node, loop iteration and fanout branch).
 *
 * Judgment capture builds the same keys to read a call's records back.
 */
export function toolCallRecordKey(input: {
  readonly toolId: string;
  readonly key: string;
  /** The model's id for an agent turn's call; absent for a flow's tool step. */
  readonly callId?: string;
}): string {
  return input.callId === undefined
    ? `tool-call:${input.toolId}:${input.key}`
    : `tool-call:${input.callId}:${input.toolId}:${input.key}`;
}

/** The `ToolContext.record` key a runtime keeps a call's resolved env values under. */
export const TOOL_ENV_RECORD_KEY = 'env';
