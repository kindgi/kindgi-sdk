// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export type KernelError =
  | RunNotFoundError
  | FlowMismatchError
  | RunAlreadyTerminalError
  | NodeExecutionError
  | JournalError
  | WaitpointError
  | HandlerMissingError
  | StuckRunError
  | RunLeaseLostError;

export interface RunNotFoundError {
  readonly code: 'run-not-found';
  readonly message: string;
  readonly runId: string;
}

/** `resumeRun` was called with a flow whose id/version does not match the run's. */
export interface FlowMismatchError {
  readonly code: 'flow-mismatch';
  readonly message: string;
  readonly expected: { readonly id: string; readonly version: string };
  readonly got: { readonly id: string; readonly version: string };
}

/** Attempted to resume or step a run that has already completed / failed / cancelled. */
export interface RunAlreadyTerminalError {
  readonly code: 'run-already-terminal';
  readonly message: string;
  readonly runId: string;
  readonly status: string;
}

/** A node handler threw. The runtime catches, journals, and returns this. */
export interface NodeExecutionError {
  readonly code: 'node-execution-error';
  readonly message: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly cause: unknown;
}

/** Journal read/write failed at the storage layer. */
export interface JournalError {
  readonly code: 'journal-error';
  readonly message: string;
  readonly cause: unknown;
}

/** Waitpoint-related error (double-completion, missing token, etc.). */
export interface WaitpointError {
  readonly code: 'waitpoint-error';
  readonly message: string;
  readonly tokenId: string;
}

/**
 * Handlers are missing for some of a flow's nodes — returned by
 * `runGraph` / `resumeRun`, or by a `HandlerResolver` binding a child flow.
 */
export interface HandlerMissingError {
  readonly code: 'handler-missing';
  readonly message: string;
  readonly nodeIds: readonly string[];
}

/**
 * The run's scheduling loop reached a state where no node is ready, no
 * edge remains to evaluate, nothing is in flight or suspended, and the
 * flow is not done. Marked failed to prevent an infinite loop.
 */
export interface StuckRunError {
  readonly code: 'stuck';
  readonly message: string;
  readonly runId: string;
}

/**
 * This executor no longer holds the run's lease: another executor claimed
 * it (after this one's lease expired) and owns the run now. The executor
 * stops without failing or finishing the run; whoever holds the lease
 * decides what happens to it. Returned by `runGraph` / `resumeRun` when a
 * write is refused because the run's lease epoch moved on.
 */
export interface RunLeaseLostError {
  readonly code: 'run-lease-lost';
  readonly message: string;
  readonly runId: string;
}
