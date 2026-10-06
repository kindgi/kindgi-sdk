// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Principal } from '@kindgi/authz';
import type { Flow, FlowVersionOverrides } from '@kindgi/flow';
import type { HandlerRegistry } from '@kindgi/handler';
import type {
  AgentVersionVia,
  ConversationId,
  LiveScope,
  NodeId,
  ProjectId,
  Result,
  RunId,
  TenantId,
} from '@kindgi/types';

import type { HandlerMissingError } from './errors.js';
import type { KernelEventBusBinding } from './event-bus.js';
import type { RunOptions } from './types.js';

/**
 * Resolver contract for `subgraph` node dispatch. Structurally
 * satisfied by `FlowRegistryBinding.getVersion(...)` in `@kindgi/api`.
 * The runtime invokes the resolver with the PARENT run's tenantId; a
 * flow registered under a different tenant returns `null`, which is
 * the cross-tenant guarantee (rejection at dispatch with
 * `subgraph-flow-not-found` attribution).
 */
export interface FlowResolver {
  getVersion(input: {
    readonly tenantId: TenantId;
    readonly flowId: string;
    readonly version: string;
  }): Promise<Flow | null>;
}

/**
 * The node in a parent run that started this run as its child — a
 * subgraph node's sub-run, or the agent turn an agent step launches.
 * Stored on the child's row, so a parent (or a caller) can find the
 * children of a run, and a resumed child can wake the parent that waits
 * on it.
 */
export interface ParentRunRef {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /**
   * Distinguishes children of the same node — one per loop iteration.
   * The enclosing loop stack, serialized; `''` for a node outside any
   * loop.
   */
  readonly scope: string;
}

/**
 * The agent an agent turn's run is for: which agent, at which version, in
 * which conversation. Stored on the run's row when the run starts, so the
 * run record names it; set on the runs of `agent.turn` (an agent run, or
 * a flow's agent step) and on no other run.
 */
export interface RunAgentRef {
  readonly id: string;
  readonly version: string;
  readonly conversationId: ConversationId;
  /** Why this version ran (absent on runs from before it was recorded). */
  readonly via?: AgentVersionVia;
  /** The pin that chose it, when `via` is `live`. */
  readonly liveScope?: LiveScope;
}

/** Marks a run as a replay: an eval run re-running a past run (`of`). */
export interface RunReplayRef {
  readonly of: RunId;
  readonly evalRunId: string;
}

/**
 * Binds the handlers for a flow the runtime is about to run or resume —
 * the root flow and every child flow a subgraph node starts. Lets a
 * child flow get handlers for its own nodes instead of sharing the
 * parent's registry.
 */
export interface HandlerResolver {
  resolve(input: {
    readonly tenantId: TenantId;
    readonly projectId: ProjectId;
    readonly flow: Flow;
    readonly dryRun: boolean;
  }): Promise<Result<HandlerRegistry, HandlerMissingError>>;
}

export interface RunFlowInput {
  readonly tenantId: TenantId;
  /**
   * Content-scope anchor. REQUIRED — every kernel run is bound to
   * exactly one project inside the tenant. Callers without a natural
   * project id resolve to the tenant's Default via
   * `projectBinding.getDefault(tenantId)` at the caller layer.
   */
  readonly projectId: ProjectId;
  readonly flow: Flow;
  readonly handlers: HandlerRegistry;
  readonly input: unknown;
  readonly options?: RunOptions;
  /**
   * Optional flow resolver — required for flows that contain
   * `subgraph` nodes. Absent resolver → subgraph nodes fail
   * immediately with reason `resolver-missing`.
   */
  readonly flowResolver?: FlowResolver;
  /**
   * Internal: subgraph depth of THIS run. Populated by the runtime
   * when a parent's `subgraph` node dispatches a child. External
   * callers do NOT set this — it always starts at `0` for a
   * top-level `RunBinding.runGraph` call.
   */
  readonly subgraphDepth?: number;
  /** The parent node that started this run, when it is a child run. */
  readonly parent?: ParentRunRef;
  /** The agent this run is a turn of; see `RunAgentRef`. */
  readonly agent?: RunAgentRef;
  /** Set when an eval run is replaying a past run; see `RunReplayRef`. */
  readonly replay?: RunReplayRef;
  /**
   * Agents and tools this run uses at other exact versions than the flow
   * version's pins (`withVersions`): "this flow, with `acme.scorer` at
   * 0.4.0". The run keeps them, so a resumed run binds the same. `flow`
   * is the flow version as published; the caller applies them to bind.
   */
  readonly versions?: FlowVersionOverrides;
  /**
   * Run an existing `pending` row (created by `startRun`) instead of
   * inserting a new one — how a caller hands back a run id before the
   * run finishes. The row keeps what `startRun` stored (`agent` too).
   */
  readonly runId?: RunId;
  /** Handlers for child flows; see `HandlerResolver`. */
  readonly handlerResolver?: HandlerResolver;
  /**
   * Optional push-based event bus. When set, the runtime publishes
   * a `JournalEntry`-shaped `doc` to `kernel:run:<runId>` after each
   * successful journal write. When absent, journal writes still land
   * durably.
   */
  readonly eventBus?: KernelEventBusBinding;
  /**
   * Authorization — the Principal on whose authority this run
   * executes. When set together with `authz`, every `ctx.authorize` /
   * `can` / `check` inside handlers is decided against this principal.
   */
  readonly principal?: Principal;
  /**
   * Authorization config — enables authorization checks inside the
   * runtime. When absent, `ctx.authorize` is a no-op and tool
   * invocations skip their pre-flight check.
   */
  readonly authz?: {
    readonly fgaApiUrl: string;
  };
}

export interface ResumeRunInput {
  readonly tenantId: TenantId;
  readonly runId: RunId;
  readonly flow: Flow;
  readonly handlers: HandlerRegistry;
  readonly options?: RunOptions;
  /** Same shape as `RunFlowInput.flowResolver`. */
  readonly flowResolver?: FlowResolver;
  /**
   * Internal: subgraph depth of THIS run when it was originally
   * started. Callers on the top level do NOT set this.
   */
  readonly subgraphDepth?: number;
  /** Same shape + semantics as `RunFlowInput.handlerResolver`. */
  readonly handlerResolver?: HandlerResolver;
  /** Same shape + semantics as `RunFlowInput.eventBus`. */
  readonly eventBus?: KernelEventBusBinding;
  /**
   * Authorization — carried through on resume so the resumed run
   * keeps enforcing per-tool + per-subgraph checks.
   */
  readonly principal?: Principal;
  readonly authz?: {
    readonly fgaApiUrl: string;
  };
}

export interface StartRunParams {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly flowId: string;
  readonly flowVersion: string;
  readonly input: unknown;
  readonly dryRun?: boolean;
  /** The parent node that starts this run, when it is a child run. */
  readonly parent?: ParentRunRef;
  /** The agent this run is a turn of; see `RunAgentRef`. */
  readonly agent?: RunAgentRef;
  /** Set when an eval run is replaying a past run; see `RunReplayRef`. */
  readonly replay?: RunReplayRef;
  /** The versions the run swaps in over its flow version's pins; see `RunFlowInput.versions`. */
  readonly versions?: FlowVersionOverrides;
}

export type StartRunError = { readonly code: 'insert-failed'; readonly message: string };

export interface DeleteRunParams {
  readonly tenantId: TenantId;
  readonly runId: RunId;
}

export type DeleteRunError = {
  readonly code: 'not-found' | 'delete-failed';
  readonly message?: string;
};
