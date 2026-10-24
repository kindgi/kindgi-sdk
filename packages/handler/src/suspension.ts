// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { NodeId } from '@kindgi/types';

/**
 * The `reason` a waitpoint is cancelled with when its `timeoutMs` passes.
 * A caller that parks on a token tells a timeout from any other cancel by
 * it (`WaitpointCancelledError.reason`). A host may configure another
 * reason for its own waits, but never for a tool call's pause, whose
 * timeout is always this one.
 */
export const WAITPOINT_TIMEOUT_REASON = 'timeout';

/**
 * Thrown from `NodeContext.waitForToken()` on flow replay when the
 * waitpoint was cancelled externally (`RunBinding.cancelToken` in
 * `@kindgi/runtime`, or a timeout) before a decision was recorded.
 * Distinct JS Error class so a handler's `try { ... } catch (e) { ... }`
 * can branch on the cancellation reason.
 *
 * Uncaught → propagates to the executor's dispatch catch, which treats
 * it as a normal handler failure and journals `step.failed` with the
 * reason attributed. Callers who want to handle the cancel gracefully
 * (HITL: turn the reject into a clean `hitl-cancelled` failure) catch
 * it explicitly and translate.
 */
export class WaitpointCancelledError extends Error {
  readonly tokenId: string;
  readonly nodeId: NodeId;
  readonly reason: string;
  constructor(tokenId: string, nodeId: NodeId, reason: string) {
    super(`Waitpoint "${tokenId}" at node "${nodeId}" was cancelled: ${reason}`);
    this.name = 'WaitpointCancelledError';
    this.tokenId = tokenId;
    this.nodeId = nodeId;
    this.reason = reason;
  }
}
