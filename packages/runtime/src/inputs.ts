// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Principal } from '@kindgi/authz';
import type { Flow, FlowVersionOverrides } from '@kindgi/flow';
import type { HandlerRegistry } from '@kindgi/handler';
import type {
  AgentPinScope,
  AgentVersionVia,
  ConversationId,
  FlowVersionVia,
  NodeId,
  PinScope,
  ProjectId,
  Result,
  RunId,
  ScopeSegment,
  TenantId,
  Timestamp,
  TriggerId,
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
  /** The pin that chose it, when `via` is `pinned`. */
  readonly pinnedScope?: AgentPinScope;
}

/** Marks a run as a replay: a test run re-running a past run (`of`). */
export interface RunReplayRef {
  readonly of: RunId;
  readonly testRunId: string;
  /** The test case the replay ran, by its id in the test set; a test run sets it on each replay. */
  readonly caseId?: string;
}

/** Every value of `RunTriggerRef.kind`. */
export const RUN_TRIGGER_KINDS = ['schedule', 'event', 'webhook', 'mail'] as const;

/**
 * Marks a run a trigger started: the trigger, the fire that started it,
 * and for a schedule the occurrence it ran for.
 */
export interface RunTriggerRef {
  readonly triggerId: TriggerId;
  readonly kind: (typeof RUN_TRIGGER_KINDS)[number];
  readonly fireId: string;
  /** A schedule's fire: the occurrence it ran for. */
  readonly scheduledFor?: Timestamp;
  /**
   * The trigger's version its fire's start used (`TriggerVersionRecord`),
   * which the run keeps whatever later edits make. Only the runtime sets
   * it. Absent on a run from before versions.
   */
  readonly version?: number;
}

/** Every value of `RunStartedBy`. */
export const RUN_STARTED_BY = ['person', 'key', 'schedule', 'webhook', 'event', 'mail'] as const;

/**
 * How a run started, recorded with it and never changed: a person
 * (`person`), a service account's key (`key`), or the kind of trigger
 * that fired it (`schedule`, `webhook`, `event`, `mail`). A child run
 * takes its parent's. A person's own API key starts runs as that person.
 *
 * Only `person` counts as attended (`runIsAttended`): a run with any other
 * value, or with none, is one no person is watching, so a tool that
 * declares `needsApprovalWhenUnattended` waits for a person's yes in it.
 */
export type RunStartedBy = (typeof RUN_STARTED_BY)[number];

/** Whether a person is watching the run: only when it says a person started it. */
export function runIsAttended(startedBy: RunStartedBy | undefined): boolean {
  return startedBy === 'person';
}

/**
 * The mailbox a mail trigger's run started from: the app, and whose
 * connection the trigger reads it with, the company's or the trigger
 * owner's. The run keeps it through the trigger version it started under
 * (`RunTriggerRef.version`), whatever later edits make; a child run takes
 * its parent's. In such a run a further read of that mailbox is steered by the
 * mail, so a call with a connection of this app and kind waits for a
 * person's yes, read-only or not (`needsPersonsYesUnattended`).
 */
export interface RunMailbox {
  readonly app: 'google' | 'microsoft';
  readonly as: 'company' | 'person';
}

/**
 * Whom a run acts for, whose access it has: a person (`user:<id>`) or a
 * service account (`service_account:<id>`), named as an approval's
 * `requestedBy` and a conversation's `openedBy` name them. Recorded with
 * the run and never changed: a run a schedule or a webhook fired acts for
 * the trigger's owner, a child run for its parent's, an agent acting for
 * someone for that someone. An id, never a name.
 */
export type RunActsFor = `user:${string}` | `service_account:${string}`;

/**
 * What the rule for runs no person started reads of a tool: its flags,
 * and its `needsSpec.connections` (`@kindgi/tools`' `ConnectionNeed`s,
 * each an `app` and `as: 'person' | 'company'`).
 */
export interface UnattendedRuleTool {
  readonly id: string;
  readonly needsApprovalWhenUnattended?: boolean;
  readonly mutating?: boolean;
  readonly needsSpec?: object;
}

/**
 * Whether a call of `tool` needs a person's yes in a run no person
 * started: it declares `needsApprovalWhenUnattended`, or it uses a
 * person's connection (a `needsSpec.connections` entry `as: 'person'`),
 * reads included. So a tool that reads or sends as someone never runs
 * unasked under a trigger because its author left the flag off or marked
 * it `mutating: false`; `needsApprovalWhenUnattended: false` doesn't lift
 * it either.
 */
export function toolNeedsPersonsYesUnattended(tool: UnattendedRuleTool): boolean {
  const reason = waitReasonOf(tool, undefined, undefined);
  return reason === 'declared' || reason === 'persons-connection';
}

/**
 * Why a call waits for a person's yes in a run no person started
 * (`unattendedWaitReason`):
 *
 * - `declared`: the tool declares `needsApprovalWhenUnattended`;
 * - `persons-connection`: it uses a person's connection, reads included;
 * - `mail-change`: a mail started the run, and the tool changes something
 *   (it isn't `mutating: false`);
 * - `mail-own-mailbox`: a mail started the run, and the tool uses a
 *   connection of the run's own mailbox, read-only or not.
 */
export type UnattendedWaitReason =
  | 'declared'
  | 'persons-connection'
  | 'mail-change'
  | 'mail-own-mailbox';

/**
 * Why a call of `tool` waits for a person's yes because no person is
 * watching its run (`runIsAttended`), or `undefined` when it doesn't. It
 * waits, for the first reason that holds, in this order:
 *
 * - the tool declares it (`declared`), or uses a person's connection
 *   (`persons-connection`), in any such run (`toolNeedsPersonsYesUnattended`);
 * - a mail started the run (`mail`), and the tool changes something
 *   (`mail-change`: it isn't `mutating: false`), or it uses a connection of
 *   the run's own `mailbox`, its app and kind (`mail-own-mailbox`; any
 *   connection, when the run records no mailbox).
 *
 * Unless the trigger that started the run lists the tool in its
 * `toolsAllowedUnattended`: only the runs a webhook, a schedule or a mail
 * trigger started have a list, and on any other one lifts nothing. The one
 * rule an agent's tool gate and a flow's tool step both apply, so a
 * refusal's message names the reason this gives.
 */
export function unattendedWaitReason(
  tool: UnattendedRuleTool,
  startedBy: RunStartedBy | undefined,
  toolsAllowedUnattended: readonly string[] | undefined,
  mailbox?: RunMailbox,
): UnattendedWaitReason | undefined {
  if (runIsAttended(startedBy)) return undefined;
  const reason = waitReasonOf(tool, startedBy, mailbox);
  if (reason === undefined) return undefined;
  const listed =
    (startedBy === 'webhook' || startedBy === 'schedule' || startedBy === 'mail') &&
    toolsAllowedUnattended?.includes(tool.id) === true;
  return listed ? undefined : reason;
}

/**
 * Whether a call of `tool` waits for a person's yes because no person is
 * watching its run: whether `unattendedWaitReason` gives a reason.
 */
export function needsPersonsYesUnattended(
  tool: UnattendedRuleTool,
  startedBy: RunStartedBy | undefined,
  toolsAllowedUnattended: readonly string[] | undefined,
  mailbox?: RunMailbox,
): boolean {
  return unattendedWaitReason(tool, startedBy, toolsAllowedUnattended, mailbox) !== undefined;
}

/** The first reason a call of `tool` waits in an unattended run, before the list. */
function waitReasonOf(
  tool: UnattendedRuleTool,
  startedBy: RunStartedBy | undefined,
  mailbox: RunMailbox | undefined,
): UnattendedWaitReason | undefined {
  if (tool.needsApprovalWhenUnattended === true) return 'declared';
  const needs = connectionNeedsOf(tool);
  if (needs.some((need) => need.as === 'person')) return 'persons-connection';
  if (startedBy !== 'mail') return undefined;
  if (tool.mutating !== false) return 'mail-change';
  const ownMailbox = needs.some(
    (need) => mailbox === undefined || (need.app === mailbox.app && need.as === mailbox.as),
  );
  return ownMailbox ? 'mail-own-mailbox' : undefined;
}

/** A tool's `needsSpec.connections` entries, as the rule reads them. */
function connectionNeedsOf(
  tool: UnattendedRuleTool,
): readonly { readonly app?: unknown; readonly as?: unknown }[] {
  const { connections } = (tool.needsSpec ?? {}) as {
    readonly connections?: Readonly<
      Record<string, { readonly app?: unknown; readonly as?: unknown }>
    >;
  };
  return connections === undefined ? [] : Object.values(connections);
}

/**
 * The idempotency key of a run start: a start with a key a run of the
 * tenant already has starts nothing and answers that run (`existing`), so
 * a retried or re-driven start never runs twice. A trigger's fire uses
 * `fire:<fireId>`. Keys are opaque, at most 255 characters.
 */
export type RunIdempotencyKey = string;

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
   * project id resolve to the tenant's default via
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
  /** Set when a test run is replaying a past run; see `RunReplayRef`. */
  readonly replay?: RunReplayRef;
  /**
   * Set when the run doesn't exist yet (no `runId`): start it at most once
   * per key; see `RunIdempotencyKey`. A key a run already has runs nothing
   * and answers that run's current state.
   */
  readonly idempotencyKey?: RunIdempotencyKey;
  /** Set when a trigger started the run; see `RunTriggerRef`. */
  readonly trigger?: RunTriggerRef;
  /**
   * How the run started; see `RunStartedBy`. Absent: the run records none,
   * and counts as unattended.
   */
  readonly startedBy?: RunStartedBy;
  /**
   * The tools, by id, a call of which doesn't wait for a person's yes
   * though no person started the run (`needsPersonsYesUnattended`): the
   * `toolsAllowedUnattended` of the webhook, schedule or mail trigger that
   * started it, as the trigger version it started under has it
   * (`RunTriggerRef.version`). The run keeps that version whatever later
   * edits make; a child run takes its parent's. Absent: none.
   */
  readonly toolsAllowedUnattended?: readonly string[];
  /**
   * The mailbox the run's mail came from (`RunMailbox`), on a run a mail
   * trigger started (`startedBy: 'mail'`), as the trigger version it
   * started under has it, kept the same way as `toolsAllowedUnattended`.
   * Absent on every other run.
   */
  readonly mailbox?: RunMailbox;
  /**
   * The W3C trace id of the request that started the run (32 lowercase
   * hex), kept on the run so its later turns and resumes can name the
   * trace they began in. Absent for a run no request started.
   */
  readonly traceId?: string;
  /**
   * Agents and tools this run uses at other exact versions than the flow
   * version's pins (`withVersions`): "this flow, with `acme.scorer` at
   * 0.4.0". The run keeps them, so a resumed run binds the same. `flow`
   * is the flow version as published; the caller applies them to bind.
   */
  readonly versions?: FlowVersionOverrides;
  /**
   * How the caller chose the run's flow version: named (`explicit`), the
   * version pinned for the run's project (`pinned`, with the pin's scope
   * in `flowPinnedScope`), or the newest the project reaches (`latest`).
   * Recorded with the run and never changed. Absent: not recorded.
   */
  readonly flowVersionVia?: FlowVersionVia;
  readonly flowPinnedScope?: PinScope;
  /**
   * The run's segment path (ordered, coarse to fine), which picks pinned agent
   * versions; a child run inherits its parent's.
   */
  readonly segments?: readonly ScopeSegment[];
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
   * The Principal on whose authority this run executes: who started it
   * (a caller, a schedule's creator, a service identity). Stored with
   * the run, so every resume (an approval, a timeout, a child waking its
   * flow, a run recovered after a crash) acts for the same principal.
   * Only the start stores it: a pending run (`StartRunParams`) keeps the
   * one it was started with, none included, whoever adopts it.
   * When set together with `authz`, every `ctx.authorize` / `can` /
   * `check` inside handlers is decided against it; on its own it only
   * informs (e.g. whose own memory an agent turn may read).
   */
  readonly principal?: Principal;
  /**
   * Authorization config — enables authorization checks inside the
   * runtime. When absent, `ctx.authorize` is a no-op and tool
   * invocations skip their pre-flight check. From runtime 0.1.8, the
   * Kindgi runtime sets it (OpenFGA's URL only) on every run a person or
   * a key starts.
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
  // No principal: a resumed run acts for the one stored when it started
  // (`RunFlowInput.principal`); a resume can't drop or change it.
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
  /** Set when a test run is replaying a past run; see `RunReplayRef`. */
  readonly replay?: RunReplayRef;
  /** Start it at most once per key; see `RunIdempotencyKey`. */
  readonly idempotencyKey?: RunIdempotencyKey;
  /** Set when a trigger started the run; see `RunTriggerRef`. */
  readonly trigger?: RunTriggerRef;
  /** How the run started; see `RunFlowInput.startedBy`. */
  readonly startedBy?: RunStartedBy;
  /** What it may call without a person's yes; see `RunFlowInput.toolsAllowedUnattended`. */
  readonly toolsAllowedUnattended?: readonly string[];
  /** The mailbox a mail trigger's run came from; see `RunFlowInput.mailbox`. */
  readonly mailbox?: RunMailbox;
  /** The trace id of the request that started the run; see `RunFlowInput.traceId`. */
  readonly traceId?: string;
  /** The versions the run swaps in over its flow version's pins; see `RunFlowInput.versions`. */
  readonly versions?: FlowVersionOverrides;
  /** How the run's flow version was chosen; see `RunFlowInput.flowVersionVia`. */
  readonly flowVersionVia?: FlowVersionVia;
  readonly flowPinnedScope?: PinScope;
  /** The run's segment path; see `RunFlowInput.segments`. */
  readonly segments?: readonly ScopeSegment[];
  /** Who starts the run; stored with it, see `RunFlowInput.principal`. */
  readonly principal?: Principal;
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
