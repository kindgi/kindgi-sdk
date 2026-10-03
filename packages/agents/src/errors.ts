// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export type AgentError =
  | InvalidAgentError
  | AgentNotFoundError
  | AgentAlreadyRegisteredError
  | AgentVersionMismatchError
  | ConversationNotFoundError
  | ConversationClosedError
  | InvalidMessageError
  | PersistenceError;

/** `defineAgent` was called with a shape that fails validation. */
export interface InvalidAgentError {
  readonly code: 'invalid-agent';
  readonly message: string;
  readonly issues: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

/** A registry lookup by (id, version) missed. */
export interface AgentNotFoundError {
  readonly code: 'agent-not-found';
  readonly message: string;
  readonly agentId: string;
  readonly version?: string;
}

/** Trying to register an agent that already exists at that (id, version). */
export interface AgentAlreadyRegisteredError {
  readonly code: 'agent-already-registered';
  readonly message: string;
  readonly agentId: string;
  readonly version: string;
}

/**
 * A caller resumed a conversation but supplied an agent version that
 * doesn't match the conversation's opening agent. Agents evolve; a
 * conversation must be resumed with the same agent version it started
 * with.
 */
export interface AgentVersionMismatchError {
  readonly code: 'agent-version-mismatch';
  readonly message: string;
  readonly conversationId: string;
  readonly expectedVersion: string;
  readonly actualVersion: string;
}

/** No conversation with the given id exists (for this tenant). */
export interface ConversationNotFoundError {
  readonly code: 'conversation-not-found';
  readonly message: string;
  readonly conversationId: string;
}

/** Attempted to append or otherwise mutate a closed conversation. */
export interface ConversationClosedError {
  readonly code: 'conversation-closed';
  readonly message: string;
  readonly conversationId: string;
}

/** `appendMessage` was called with malformed inputs (blank content, bad role, etc.). */
export interface InvalidMessageError {
  readonly code: 'invalid-message';
  readonly message: string;
  readonly reason: string;
}

/** Storage-layer error. Cause carries the underlying DB / IO failure. */
export interface PersistenceError {
  readonly code: 'persistence-error';
  readonly message: string;
  readonly cause: unknown;
}
