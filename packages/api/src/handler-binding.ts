// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/agents';
import type { Principal } from '@kindgi/authz';
import type { FlowVersionOverrides } from '@kindgi/flow';
import type { RunIdempotencyKey, RunTriggerRef } from '@kindgi/runtime';
import type { FlowId, ProjectId, RunId, ScopeSegment, Semver, TenantId } from '@kindgi/types';

/**
 * Callback the platform HTTP surface hands off to when it receives
 * `POST /v1/runs`. The API package intentionally does NOT depend on
 * `AgentRegistry`, `ProviderRegistry`, `ToolRegistry`, or the wiring
 * that assembles an `InvokeAgentBindings` — the caller wires those and
 * exposes them through this thin binding.
 *
 * Why: keeps `@kindgi/api` narrow (Hono + routing + error mapping)
 * while letting deployments — a local dev server, a hosted platform, a
 * self-hosted install — assemble the runtime dependencies however they
 * need to. Same pattern as `TokenResolver` for auth.
 *
 * Both methods block until the run reaches a terminal or suspended
 * state — unless the input's `wait` is `false`, in which case they
 * return the `runId` as soon as the run exists. The API layer only
 * needs the `runId` to re-read the row and respond.
 *
 * Domain errors are returned as `RunHandlerFailure`; the route layer
 * maps `code` to the HTTP status via `ERROR_CODE_TO_STATUS`.
 */
export interface RunHandlerBinding {
  /**
   * Called when the request body has `{ agent: AgentId, ... }`. The
   * binding is expected to look up the agent, build the invocation
   * bindings, and call `invokeAgent` from `@kindgi/agents` (or an
   * equivalent). Return the underlying `RunId` on success.
   */
  invokeAgent(input: InvokeAgentBindingInput): Promise<RunHandlerOutcome>;

  /**
   * Called when the request body has `{ flow: FlowId, ... }`. The
   * binding is expected to resolve the flow to its `Flow` value +
   * `HandlerRegistry` and start it with `RunBinding.runGraph`
   * (`@kindgi/runtime`).
   */
  invokeFlow(input: InvokeFlowBindingInput): Promise<RunHandlerOutcome>;

  /**
   * Resume a suspended run — invoked after a waitpoint resolves (e.g. a
   * reviewer's decision writes `wait.resumed`; a timeout writes
   * `wait.cancelled`). The binding reconstructs the same flow + handler
   * context the run started with and calls `RunBinding.resumeRun`,
   * blocking until the run reaches its next terminal state (or the next
   * suspension). Same runId, same conversation, same provenance record —
   * park-and-resume preserves audit-trail continuity across HITL cycles.
   *
   * Returns the same shape as `invokeAgent` / `invokeFlow`: the runId
   * on success; a `RunHandlerFailure` when the resume path errors before
   * the run is picked up.
   */
  resumeRun(input: ResumeRunBindingInput): Promise<RunHandlerOutcome>;
}

/** The request's W3C trace context, for the run it starts (`traceId` is kept on the run). */
export interface RunTrace {
  readonly traceId: string;
  readonly spanId: string;
}

export interface ResumeRunBindingInput {
  readonly tenantId: TenantId;
  readonly runId: RunId;
}

export interface InvokeAgentBindingInput {
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor. Omit → the binding
   * resolves the tenant's Default via `projectBinding.getDefault(...)`
   * at its own caller layer. Route callers who supply a project id in
   * the body thread it through here.
   */
  readonly projectId?: ProjectId;
  readonly agentId: AgentId;
  /**
   * Omit → the binding chooses: the conversation's own version for a
   * follow-up turn, else the version live for the run's scope, else the
   * latest registered.
   */
  readonly agentVersion?: Semver;
  /**
   * The run's segment path below its project, coarse to fine (an
   * app-defined finer scope, e.g. company then role): a live version
   * pinned on a prefix of it serves the run.
   */
  readonly segments?: readonly ScopeSegment[];
  /**
   * Opaque payload forwarded from the request body's `input` field.
   * The binding is responsible for coercing this into whatever shape
   * `invokeAgent` expects (typically `{ userMessage, conversationId?, parameters?, participantId? }`).
   * Coercion failures should surface as `code: 'bad-input'`.
   */
  readonly input: unknown;
  readonly dryRun?: boolean;
  /**
   * `false` → return the run id as soon as the run exists and finish it
   * in the background (the route answers `202`; callers poll
   * `GET /v1/runs/:runId`). Absent or `true` → return once the run
   * reaches a terminal or suspended state. A binding that
   * can't run in the background may treat `false` like `true`.
   */
  readonly wait?: boolean;
  /**
   * Start the run at most once per key (`RunIdempotencyKey`): a key a run
   * already has starts nothing and answers that run, with `existing`.
   */
  readonly idempotencyKey?: RunIdempotencyKey;
  /** Set when a trigger starts the run; the run records it (`RunTriggerRef`). */
  readonly trigger?: RunTriggerRef;
  /**
   * Who started the run (the authenticated caller), when known: whom the
   * turn acts for, e.g. whose own memory its retrievals may read. Set by
   * the route, never from the body. On its own it enforces nothing.
   */
  readonly principal?: Principal;
  /** The trace context of the request starting the run: the binding records its `traceId` on the run. */
  readonly trace?: RunTrace;
}

export interface InvokeFlowBindingInput {
  readonly tenantId: TenantId;
  readonly projectId?: ProjectId;
  readonly flowId: FlowId;
  readonly flowVersion?: Semver;
  /** The run's segment path, as for an agent run: its agent steps resolve live versions with it. */
  readonly segments?: readonly ScopeSegment[];
  readonly input: unknown;
  readonly dryRun?: boolean;
  /**
   * `false` → return the run id as soon as the run exists and finish it
   * in the background (the route answers `202`; callers poll
   * `GET /v1/runs/:runId`). Absent or `true` → return once the run
   * reaches a terminal or suspended state. A binding that
   * can't run in the background may treat `false` like `true`.
   */
  readonly wait?: boolean;
  /**
   * Start the run at most once per key (`RunIdempotencyKey`): a key a run
   * already has starts nothing and answers that run, with `existing`.
   */
  readonly idempotencyKey?: RunIdempotencyKey;
  /** Set when a trigger starts the run; the run records it (`RunTriggerRef`). */
  readonly trigger?: RunTriggerRef;
  /** Agents and tools to run at other exact versions than the flow version's pins (`RunFlowInput.versions`). */
  readonly versions?: FlowVersionOverrides;
  /** Who started the run, as for `InvokeAgentBindingInput.principal`: its agent steps act for them. */
  readonly principal?: Principal;
  /** The trace context of the request starting the run, as for an agent run. */
  readonly trace?: RunTrace;
}

export type RunHandlerOutcome =
  | {
      readonly kind: 'ok';
      readonly runId: RunId;
      /** The `idempotencyKey` named a run that already existed: nothing new started. */
      readonly existing?: true;
    }
  | { readonly kind: 'err'; readonly error: RunHandlerFailure };

/**
 * Domain error surfaced by the binding. `code` should be a value the
 * error mapper knows how to translate (e.g. `agent-not-found`,
 * `bad-input`, `unresolved-tool`, `guardrail-violation`). Unknown
 * codes fall through to 500.
 */
export interface RunHandlerFailure {
  readonly code: string;
  readonly message: string;
  /**
   * The domain error's structured fields — sent as the wire error's
   * `details`, which clients hydrate into typed errors. A binding
   * forwards them as-is: for `guardrail-violation`, `violations` and
   * `evaluationErrors` from `@kindgi/agents`' `GuardrailViolationError`.
   */
  readonly details?: Readonly<Record<string, unknown>>;
}
