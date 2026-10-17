// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

/**
 * The namespace of every tool call's idempotency key. Fixed: with it, any
 * runtime reproduces a call's key (`toolIdempotencyKey`).
 */
export const TOOL_IDEMPOTENCY_NAMESPACE = 'a70d5bff-e713-4322-b2ea-9d5c4926a861';

const NAMESPACE_BYTES = Buffer.from(TOOL_IDEMPOTENCY_NAMESPACE.replaceAll('-', ''), 'hex');

/**
 * A tool call's idempotency key (`ToolContext.idempotencyKey`): the same
 * every time the same call runs (a resume after a wait, a retry after a
 * failure, a re-run after a crash), different for every other call.
 *
 * It's a name-based UUID (RFC 9562 version 5, SHA-1) under
 * `TOOL_IDEMPOTENCY_NAMESPACE`, over the UTF-8 bytes of the JSON array
 * `[runId, stepScope, toolId]` (with `callId` appended for a call a model
 * asked for) as `JSON.stringify` writes it: no whitespace, and characters
 * beyond ASCII as themselves, never as `\u` escapes. Python's `json.dumps`
 * escapes them unless `ensure_ascii=False`, and an escaped part is another
 * key. `stepScope` is the step's own (`NodeContext.stepScope`):
 * it tells two loop iterations or two fanout branches apart, which a
 * model's call id alone doesn't (it's only unique within one answer).
 */
export function toolIdempotencyKey(input: {
  readonly runId: string;
  readonly stepScope: string;
  readonly toolId: string;
  /** The model's id for an agent turn's call; absent for a flow's tool step. */
  readonly callId?: string;
}): string {
  const parts = [input.runId, input.stepScope, input.toolId];
  if (input.callId !== undefined) parts.push(input.callId);
  const hash = createHash('sha1').update(NAMESPACE_BYTES).update(JSON.stringify(parts), 'utf8');
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
