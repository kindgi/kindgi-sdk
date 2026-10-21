// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A run paused until another system answers: the binding the routes call
 * to take that answer, and to say which waits a run has open.
 *
 * A pack tool that declares `pauses` gets a wait token with each call. Its
 * handler hands the token's link on to the system that will answer, and
 * the run waits. The answer comes back one of two ways:
 *   - the link, `POST /v1/wait-tokens/{token}/complete`, with no
 *     `Authorization` header: the token is the credential;
 *   - `POST /v1/runs/{runId}/resume` with an API key and a `pause:`
 *     waitpoint id (`write` on the run's project, `execute` on what it
 *     runs).
 * Either way the body is the tool's output, checked against the tool's
 * output schema before it's taken.
 *
 * The runtime implements the binding; `@kindgi/api` holds no reference to
 * how tokens are stored.
 */

import type { Principal } from '@kindgi/authz';
import type { Result, RunId, TenantId } from '@kindgi/types';

/** An answer to a wait: through the link, or through the API. */
export type CompleteWaitTokenInput =
  | {
      readonly via: 'link';
      /** The token from the link's path, as it came. */
      readonly token: string;
      readonly output: unknown;
    }
  | {
      readonly via: 'api';
      readonly tenantId: TenantId;
      readonly runId: RunId;
      /** The waitpoint id, `pause:…`: a wait of this run, or `wait-token-not-found`. */
      readonly tokenId: string;
      readonly output: unknown;
      /** Who answered, for the audit entry; absent on a runtime without authorization. */
      readonly principal?: Principal;
    };

/**
 * The answer is the runtime's. `resolved`: the run was waiting and has
 * the answer now, so the route resumes it (the link behind its answer, the
 * resume route in the same request). Otherwise the run hasn't reached its
 * wait yet, or the same answer came before. An answer that came before the
 * run reached its wait is held for it, and dropped if the run never waits
 * on this token (the tool answered at once, or its step was retried); the
 * link then answers `409 wait-token-closed`, `unused`. Never on the wire:
 * the link answers `{ status: 'accepted' }` alone.
 */
export interface WaitTokenAccepted {
  readonly status: 'accepted';
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly resolved: boolean;
}

/**
 * Why a wait that's over takes no answer:
 *   - `answered`: it holds an earlier, different answer the run hasn't taken yet;
 *   - `completed`: it took a different answer;
 *   - `timed-out`: its time passed first;
 *   - `cancelled`: the run was cancelled;
 *   - `unused`: the tool answered without waiting, or the step was retried
 *     and waits on a new token.
 */
export type WaitTokenState = 'answered' | 'completed' | 'timed-out' | 'cancelled' | 'unused';

/** Every value of `WaitTokenState`, in the order the wire lists them. */
export const WAIT_TOKEN_STATES: readonly WaitTokenState[] = [
  'answered',
  'completed',
  'timed-out',
  'cancelled',
  'unused',
];

/** Why an answer isn't taken. */
export type WaitTokenRefusal =
  /** No such token, or the secret doesn't match: the two are never told apart. */
  | { readonly code: 'wait-token-not-found' }
  | { readonly code: 'wait-token-closed'; readonly state: WaitTokenState }
  /** The answer doesn't fit the tool's output schema; the wait stays open. */
  | { readonly code: 'wait-token-output-invalid'; readonly issues: readonly unknown[] }
  /**
   * The run's tenant is closing or suspended, or its state can't be read
   * (`unreadable`, which fails closed). Nothing is taken or held. Closing or
   * suspending cancels the tenant's runs, paused ones included, so this
   * answers an answer that comes before the cancel reaches its run; an
   * `unreadable` one leaves the wait open for the same answer again.
   * Answered as every write of a frozen tenant is.
   */
  | { readonly code: 'tenant-frozen'; readonly state: 'closing' | 'suspended' | 'unreadable' }
  /** The run's project is suspended, which cancels its runs: nothing is taken. */
  | { readonly code: 'project-suspended' };

/** A run's open wait for another system's answer, as a run reader sees it. */
export interface WaitingToken {
  /** The waitpoint id (`pause:…`), never the token's secret. */
  readonly tokenId: string;
  /** What the run waits for, as the tool named it. */
  readonly name?: string;
  /** The tool whose call waits; `callId` is set for an agent's call. */
  readonly tool: { readonly id: string; readonly version: string; readonly callId?: string };
  /** The flow step that waits, for a flow's tool step. */
  readonly nodeId?: string;
  readonly createdAt: string;
  /** When the wait times out: always set, since a pause never waits for ever. */
  readonly timesOutAt: string;
}

export interface WaitTokenBinding {
  /**
   * Take an answer, as one transaction under the run's lock: check it
   * against the tool's output schema, answer by the token's state (the same
   * answer again, by its canonical JSON, is accepted again), resolve the
   * wait or hold the answer until the run reaches it, and write the audit
   * entry.
   *
   * Once the token matches, before anything else, it refuses an answer to a
   * run whose tenant is closing or suspended or whose state can't be read
   * (`tenant-frozen`), or whose project is suspended (`project-suspended`),
   * as `createApp`'s `tenantStates` and `projectSuspended` would say, and
   * takes nothing: nothing runs there. Only to a caller whose token
   * matched, as the webhook receiver tells only a sender that proved itself.
   */
  complete(input: CompleteWaitTokenInput): Promise<Result<WaitTokenAccepted, WaitTokenRefusal>>;
  /** The run's open waits for another system's answer. */
  waiting(input: {
    readonly tenantId: TenantId;
    readonly runId: RunId;
  }): Promise<readonly WaitingToken[]>;
}
