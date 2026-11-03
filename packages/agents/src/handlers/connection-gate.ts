// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Principal } from '@kindgi/authz';
import type { ModelToolCall } from '@kindgi/capabilities';
import type { NodeContext } from '@kindgi/handler';
import { WaitpointCancelledError } from '@kindgi/handler';
import { runIsAttended } from '@kindgi/runtime';
import {
  CONNECTION_GATE_RECORD_PREFIX,
  connectionGateRecordOf,
  connectionRejectionOf,
  isConnectionRenewError,
} from '@kindgi/tools';
import type {
  ConnectionGateRecord,
  ConnectionNeed,
  ConnectionRejection,
  RecordedConnection,
  ResolveConnectionsOutcome,
  Tool,
  ToolConnection,
  WaitingForConnection,
} from '@kindgi/tools';

import type { TurnContext } from './context.js';
import { throwAgentTurnFailure } from './errors.js';
import { namedAccounts } from './named-accounts.js';
import type { HitlEnqueueInput } from './public-types.js';
import type { ConnectWaitResult } from './tool-hitl.js';

/**
 * A call to a tool that declares connections (`needsSpec.connections`)
 * gets them before it runs:
 *
 * 1. **Once per call, recorded** (`connection-gate:<callId>`): the
 *    runtime's resolver finds each one. A person's connection that's
 *    missing, lacks a permission or needs reconnecting makes a connect
 *    request when the run can wait (a person started it), and the call
 *    waits for it (`computeConnectWaitToken`). The record keeps no token.
 *    A ready one says the handover below is recorded too (`recordsRan`).
 * 2. **Every time the tool runs:** a fresh resolve, never recorded, gives
 *    the tokens (`ctx.connections`). Before the tool's first run on them,
 *    the call records that its tool was handed them, in that attempt of
 *    its step (`connection-gate:<callId>:ran:<attempt>`, `kind: 'ran'`): a
 *    call these connections stopped has no such record, and one whose
 *    input then fails the tool's input check has one. The app refusing one
 *    (an HTTP 401, `ConnectionRejectedError`) renews that token and runs
 *    the call once more. A pausing call's answer from outside runs
 *    nothing, and asks for none.
 *
 * A call the connections stop runs nothing: it fails with a
 * `connection-*` code, the model reads why as its result, and the turn
 * goes on. So does a call the app refuses again with its renewed token
 * (`connection-rejected`), and the connection stays as it is, and one
 * whose fresh resolve found another connection than the gate decided on
 * (`connection-changed`). The one stop that fails the turn instead is
 * `connection-not-chosen`: several company connections and no choice of
 * one is a setup no model can fix.
 */

/**
 * Why a call that needs connections failed: it didn't run; or it ran, the
 * app refused a token, and the renewed one was refused too
 * (`connection-rejected`) or its renewal failed (another code). Whether
 * its tool was handed its connections is its gate's `ran` record
 * (`connection-gate:<callId>:ran:<attempt>`).
 */
export type ConnectionCallCode =
  | 'connection-app-missing'
  | 'connection-needs-a-person'
  | 'connection-missing'
  | 'connection-declined'
  | 'connection-timed-out'
  | 'connection-rejected'
  | 'connection-renew-failed'
  | 'connection-approval-conflict'
  | 'connection-approver-not-a-reviewer'
  | 'connection-not-chosen'
  | 'connection-changed';

/** A call the connections stopped: the model reads it as the call's result. */
export interface ConnectionCallFailure {
  readonly code: ConnectionCallCode;
  readonly message: string;
  /** The tool's name for the connection it's about. */
  readonly connection?: string;
  /** The permissions the connection lacks. */
  readonly missing?: readonly string[];
}

/** The gate's answer for a call. */
export type ConnectionGate =
  /** The tool declares no connection. */
  | { readonly kind: 'none' }
  | { readonly kind: 'ready'; readonly connections: Readonly<Record<string, RecordedConnection>> }
  | { readonly kind: 'failed'; readonly failure: ConnectionCallFailure };

/** The connections a call's tool declares, by its names for them; `undefined` when none. */
export function connectionNeedsOf(
  tool: Tool,
): Readonly<Record<string, ConnectionNeed>> | undefined {
  const needs = tool.needsSpec?.connections;
  return needs === undefined || Object.keys(needs).length === 0 ? undefined : needs;
}

/**
 * The person a turn's connections are theirs: its principal (the one it
 * acts for, else its actor) when that's a user, whatever started the run.
 * A service account's turn and an agent's own have none.
 */
export function connectionPersonOf(principal: Principal | undefined): string | undefined {
  const who = principal?.onBehalfOf ?? principal?.actor;
  return who?.kind === 'user' ? who.id : undefined;
}

/**
 * The call's connections, found once (step 1 above). A call that waited
 * for a connect asks again, once and recorded, for the account it
 * connected.
 */
export async function gateConnections(
  ctx: TurnContext,
  kctx: NodeContext,
  call: ModelToolCall,
  tool: Tool,
): Promise<ConnectionGate> {
  const needs = connectionNeedsOf(tool);
  if (needs === undefined) return { kind: 'none' };
  if (ctx.bindings.connections === undefined) return { kind: 'failed', failure: notServed(needs) };
  // A person watching the run can connect while it waits, for as long as
  // an approval would wait; any other run can't wait.
  const waitMs = runIsAttended(ctx.input.startedBy) ? (ctx.hitlPolicy?.timeoutMs ?? 0) : 0;
  const key = `${CONNECTION_GATE_RECORD_PREFIX}${call.id}`;
  // The set members the call names, by id from its turn's offer.
  const named = namedAccounts(ctx, call, tool);
  if (named.kind === 'failed') return named;
  const { accounts } = named;

  const first = await recordResolve(ctx, kctx, key, call, tool, needs, waitMs, accounts);
  if (first.kind === 'failed') return first;
  if (first.record.kind === 'ready') return first.record;
  if (first.record.kind === 'refused') return { kind: 'failed', failure: refusal(first.record) };

  for (const request of first.record.requests) {
    const failure = await waitForConnect(kctx, request);
    if (failure !== undefined) return { kind: 'failed', failure };
  }
  const connected = await recordResolve(
    ctx,
    kctx,
    `${key}:connected`,
    call,
    tool,
    needs,
    0,
    accounts,
  );
  if (connected.kind === 'failed') return connected;
  if (connected.record.kind === 'ready') return connected.record;
  if (connected.record.kind === 'refused') {
    return { kind: 'failed', failure: refusal(connected.record) };
  }
  return { kind: 'failed', failure: stillMissing(connected.record.requests) };
}

/**
 * The call's tokens, right before the tool runs (step 2 above): asked
 * fresh, never recorded, and never waiting. `decided` is what the gate
 * decided on (step 1): a need that comes to another connection now fails
 * the call (`connection-changed`), so an approved call runs only on the
 * connection it was approved against. `renew` names the ones to renew
 * first, after the app refused them. A need the call named a set's member
 * for asks for the one the gate decided on, by its id, never for the
 * name again: a rename since then moves nothing.
 */
export async function freshConnections(
  ctx: TurnContext,
  kctx: NodeContext,
  call: ModelToolCall,
  tool: Tool,
  decided: Readonly<Record<string, RecordedConnection>>,
  renew?: readonly string[],
): Promise<
  | { readonly kind: 'ready'; readonly connections: Readonly<Record<string, ToolConnection>> }
  | { readonly kind: 'failed'; readonly failure: ConnectionCallFailure }
> {
  const needs = connectionNeedsOf(tool);
  if (needs === undefined) return { kind: 'ready', connections: {} };
  if (ctx.bindings.connections === undefined) return { kind: 'failed', failure: notServed(needs) };
  const accounts = decidedAccounts(decided);
  let outcome: ResolveConnectionsOutcome;
  try {
    outcome = await resolve(ctx, kctx, call, tool, needs, 0, renew, accounts);
  } catch (cause) {
    const failure = renewFailureOf(cause);
    if (failure === undefined) throw cause;
    return { kind: 'failed', failure };
  }
  if (outcome.kind === 'refused') return { kind: 'failed', failure: refusal(outcome) };
  if (outcome.kind === 'wait') return { kind: 'failed', failure: stillMissing(outcome.requests) };
  const changed = Object.keys(needs)
    .sort()
    .find((name) => {
      const now = outcome.connections[name];
      return now !== undefined && now.connectionId !== decided[name]?.connectionId;
    });
  if (changed !== undefined) {
    const was = decided[changed];
    const now = outcome.connections[changed] as ToolConnection;
    // The run's record keeps the message, and any project reader reads it:
    // a person's connection is named by its app alone.
    const message =
      needs[changed]?.as === 'person'
        ? `The connection "${changed}" to ${now.appName} changed while this call waited, so it didn't run.`
        : `The connection "${changed}" changed while this call waited (${was === undefined ? '' : `${described(was)}, to `}${described(now)}), so it didn't run.`;
    return {
      kind: 'failed',
      failure: { code: 'connection-changed', connection: changed, message },
    };
  }
  const absent = Object.keys(needs).find((name) => outcome.connections[name] === undefined);
  if (absent !== undefined) {
    return {
      kind: 'failed',
      failure: {
        code: 'connection-missing',
        connection: absent,
        message: `The connection "${absent}" to ${needs[absent]?.app} wasn't found for this call, so it didn't run.`,
      },
    };
  }
  return { kind: 'ready', connections: outcome.connections };
}

/**
 * Record that `call`'s tool got its connections, right before it runs on
 * them (step 2 above): `connection-gate:<callId>:ran:<attempt>`, the
 * gate's ready record having said it would (`recordsRan`). Once per
 * attempt of the call's step: a renewed run in the same attempt finds it
 * recorded, and a retried step's attempt records its own.
 */
export async function recordRan(kctx: NodeContext, call: ModelToolCall): Promise<void> {
  await kctx.record(
    `${CONNECTION_GATE_RECORD_PREFIX}${call.id}:ran:${kctx.attempt ?? 1}`,
    (): ConnectionGateRecord => ({ kind: 'ran' }),
  );
}

/**
 * The connection a failed call's error says the app refused (an HTTP 401,
 * `ConnectionRejectedError`, or a pack tool's `connection-rejected`), when
 * it's one the tool declares: its token is renewed and the call runs once
 * more.
 */
export function rejectedConnectionOf(error: unknown, tool: Tool): string | undefined {
  return declaredRejectionOf(error, tool)?.connection;
}

/**
 * The call's renewed token refused too: it fails with
 * `connection-rejected`, naming the connection, with what the app said.
 * The connection stays as it is, as a refusal can mean the call lacks a
 * permission. `error` comes with the call's tokens already redacted.
 */
export function rejectedAgainOf(error: unknown, tool: Tool): ConnectionCallFailure | undefined {
  const rejection = declaredRejectionOf(error, tool);
  if (rejection === undefined) return undefined;
  return {
    code: 'connection-rejected',
    connection: rejection.connection,
    message: rejection.message,
  };
}

/** The refusal a failed call's error holds, of a connection the tool declares. */
function declaredRejectionOf(error: unknown, tool: Tool): ConnectionRejection | undefined {
  const needs = connectionNeedsOf(tool);
  if (needs === undefined) return undefined;
  // A thrown error comes wrapped: dispatch's error, then the tool's.
  const rejection = connectionRejectionOf(error);
  return rejection !== undefined && Object.hasOwn(needs, rejection.connection)
    ? rejection
    : undefined;
}

/**
 * Whom the call's approval is for, and the connection it acts with. With
 * a person's connection: its owner (of the first, by the tool's names for
 * them, sorted), and its app and account, never their name for it (the
 * run's record has none). Only they decide it. Otherwise, with a company
 * connection: the first company one, with its name, and today's
 * reviewers decide. `undefined` when the call uses neither.
 */
export function connectionApprovalOf(
  tool: Tool,
  connections: Readonly<Record<string, RecordedConnection>>,
  person: string | undefined,
): Pick<HitlEnqueueInput, 'approver' | 'connection'> | undefined {
  const name = firstPersonNeed(tool);
  if (name !== undefined) {
    if (person === undefined) return undefined;
    const seen = connections[name];
    return {
      approver: { kind: 'member', userId: person },
      ...(seen !== undefined && { connection: approvalConnection(seen, 'person') }),
    };
  }
  const company = firstNeed(tool, 'company');
  const seen = company === undefined ? undefined : connections[company];
  return seen === undefined ? undefined : { connection: approvalConnection(seen, 'company') };
}

/**
 * A connection as the approval shows it: a person's by its app alone
 * ("this person's Google account"), the company's by its account and name.
 */
function approvalConnection(
  seen: RecordedConnection,
  as: 'company' | 'person',
): NonNullable<HitlEnqueueInput['connection']> {
  if (as === 'person') return { app: seen.app, appName: seen.appName, as };
  return {
    app: seen.app,
    appName: seen.appName,
    as,
    ...(seen.account.label !== undefined && { account: seen.account.label }),
    ...(seen.name !== undefined && { name: seen.name }),
  };
}

/** A company connection as a message names it: its name and account, or the account alone. */
function described(c: {
  readonly name?: string;
  readonly account: { readonly id: string; readonly label?: string };
}): string {
  const account = c.account.label ?? c.account.id;
  return c.name !== undefined && c.name !== account ? `${c.name}, ${account}` : account;
}

/**
 * Four eyes on a call that acts with a person's connection can't be met:
 * only that person may approve it, and they're the one who asked. The
 * call is refused before anyone is asked to connect.
 */
export function connectionApprovalConflict(
  call: ModelToolCall,
  tool: Tool,
  separateApprover: boolean,
): ConnectionCallFailure | undefined {
  const name = separateApprover ? firstPersonNeed(tool) : undefined;
  if (name === undefined) return undefined;
  const app = connectionNeedsOf(tool)?.[name]?.app;
  return {
    code: 'connection-approval-conflict',
    connection: name,
    message: `${call.name} acts with a person's own connection to ${app}, so only that person can approve it, and this agent's approval rules want someone other than the person who asked (separateApprover). It can't be approved, so it didn't run.`,
  };
}

/**
 * What the approval's `enqueue` threw, as the call's failure, when it
 * refused the approver: they have no reviewer seat at the rank it needs.
 */
export function approverNotAReviewerOf(
  cause: unknown,
  call: ModelToolCall,
  tool: Tool,
  approval: Pick<HitlEnqueueInput, 'approver' | 'connection'>,
): ConnectionCallFailure | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  const { code, requiredRole } = cause as {
    readonly code?: unknown;
    readonly requiredRole?: unknown;
  };
  if (code !== 'approver-not-a-reviewer') return undefined;
  const name = firstPersonNeed(tool);
  const rank = typeof requiredRole === 'string' ? requiredRole : 'standard';
  const as =
    approval.connection === undefined
      ? 'their own connection'
      : `this person's ${approval.connection.appName} account`;
  return {
    code: 'connection-approver-not-a-reviewer',
    ...(name !== undefined && { connection: name }),
    message: `Only user ${approval.approver?.userId} can approve ${call.name}, as it acts with ${as}, and they have no reviewer seat at ${rank} or above, the rank the approval needs: a tenant admin adds them to the reviewers. The call didn't run.`,
  };
}

/** A failed call's result, as the model reads it. */
export function connectionFailureResult(failure: ConnectionCallFailure): {
  readonly status: 'failed';
  readonly error: ConnectionCallFailure;
} {
  return {
    status: 'failed',
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.connection !== undefined && { connection: failure.connection }),
      ...(failure.missing !== undefined && { missing: failure.missing }),
    },
  };
}

/** The first of the tool's person's connections, by its names for them, sorted. */
function firstPersonNeed(tool: Tool): string | undefined {
  return firstNeed(tool, 'person');
}

/** The first of the tool's connections of that kind, by its names for them, sorted. */
function firstNeed(tool: Tool, as: ConnectionNeed['as']): string | undefined {
  const needs = connectionNeedsOf(tool);
  if (needs === undefined) return undefined;
  return Object.keys(needs)
    .sort()
    .find((name) => needs[name]?.as === as);
}

/** What a gate's resolve records: the resolver's answer, never `ran`. */
type GateAnswer = Exclude<ConnectionGateRecord, { readonly kind: 'ran' }>;

/**
 * One recorded resolve: the token-free record, or the renewal that failed
 * (recorded as nothing). A ready one says the call's run is recorded too
 * (`recordsRan`, `recordRan`): with no such record, the call didn't run.
 */
async function recordResolve(
  ctx: TurnContext,
  kctx: NodeContext,
  key: string,
  call: ModelToolCall,
  tool: Tool,
  needs: Readonly<Record<string, ConnectionNeed>>,
  waitMs: number,
  accounts: Readonly<Record<string, string>> | undefined,
): Promise<
  | { readonly kind: 'recorded'; readonly record: GateAnswer }
  | { readonly kind: 'failed'; readonly failure: ConnectionCallFailure }
> {
  try {
    const record = await kctx.record(key, async (): Promise<GateAnswer> => {
      const answer = connectionGateRecordOf(
        await resolve(ctx, kctx, call, tool, needs, waitMs, undefined, accounts),
        needs,
      );
      return answer.kind === 'ready' ? { ...answer, recordsRan: true } : answer;
    });
    return { kind: 'recorded', record };
  } catch (cause) {
    const failure = renewFailureOf(cause);
    if (failure === undefined) throw cause;
    return { kind: 'failed', failure };
  }
}

function resolve(
  ctx: TurnContext,
  kctx: NodeContext,
  call: ModelToolCall,
  tool: Tool,
  needs: Readonly<Record<string, ConnectionNeed>>,
  waitMs: number,
  renew?: readonly string[],
  accounts?: Readonly<Record<string, string>>,
): Promise<ResolveConnectionsOutcome> {
  const served = ctx.bindings.connections;
  if (served === undefined) throw new Error('resolve called with no connections binding');
  const person = connectionPersonOf(ctx.input.principal);
  return served.resolver.resolveConnections({
    tenantId: ctx.input.tenantId,
    projectId: ctx.input.projectId,
    envName: served.envName,
    runId: kctx.runId as unknown as string,
    // With the call id, names the call across the run: a model's call id
    // is unique only within one answer.
    ...(kctx.stepScope !== undefined && { stepScope: kctx.stepScope }),
    callId: call.id,
    toolId: tool.id as unknown as string,
    needs,
    ...(person !== undefined && { person: { userId: person } }),
    waitMs,
    ...(renew !== undefined && { renew }),
    target: { agentId: ctx.input.agent.id as unknown as string },
    ...(ctx.input.mailbox !== undefined && { mailbox: ctx.input.mailbox }),
    ...(accounts !== undefined && { accounts }),
  });
}

/**
 * Wait for the person to connect. A timeout, or any other end of the
 * wait, fails the call, as a decline does; there's no second ask in the
 * same call.
 */
async function waitForConnect(
  kctx: NodeContext,
  request: WaitingForConnection,
): Promise<ConnectionCallFailure | undefined> {
  const left = Date.parse(request.expiresAt) - Date.now();
  let answer: unknown;
  try {
    answer = await kctx.waitForToken<unknown>(request.waitToken, {
      timeoutMs: Number.isFinite(left) ? Math.max(1, left) : 1,
    });
  } catch (cause) {
    if (!(cause instanceof WaitpointCancelledError)) throw cause;
    return {
      code: 'connection-timed-out',
      connection: request.name,
      message: `Nobody connected ${request.appName} for this call in time, so it didn't run.`,
    };
  }
  const result = connectWaitResultOf(answer);
  if (result.kind === 'connected') return undefined;
  const missing = result.missing !== undefined && result.missing.length > 0 ? result.missing : [];
  return {
    code: 'connection-declined',
    connection: request.name,
    ...(missing.length > 0 && { missing }),
    message:
      missing.length > 0
        ? `${request.appName} was connected without ${missing.join(', ')}, which this call needs, so it didn't run.`
        : `Connecting ${request.appName} for this call was declined, so it didn't run.`,
  };
}

/** A connect wait's answer; anything that isn't one counts as declined (fails closed). */
function connectWaitResultOf(value: unknown): ConnectWaitResult {
  if (value !== null && typeof value === 'object') {
    const { kind, connectionId, missing } = value as {
      readonly kind?: unknown;
      readonly connectionId?: unknown;
      readonly missing?: unknown;
    };
    if (kind === 'connected' && typeof connectionId === 'string') return { kind, connectionId };
    if (kind === 'declined') {
      return Array.isArray(missing) && missing.every((m) => typeof m === 'string')
        ? { kind, missing: missing as string[] }
        : { kind };
    }
  }
  return { kind: 'declined' };
}

/**
 * A refusal as the call's failure. `connection-not-chosen` fails the turn
 * instead, with the choices' names only.
 */
function refusal(
  refused: Extract<ConnectionGateRecord, { kind: 'refused' }>,
): ConnectionCallFailure {
  if (refused.code === 'connection-not-chosen') {
    throwAgentTurnFailure({
      code: 'connection-not-chosen',
      message: refused.message,
      connection: refused.name,
      ...(refused.choices !== undefined && { choices: refused.choices.map((c) => c.name) }),
    });
  }
  return {
    code: refused.code,
    connection: refused.name,
    ...(refused.missing !== undefined && { missing: refused.missing }),
    message: refused.message,
  };
}

/** A resolve that can't wait answered `wait` anyway: the connection is missing. */
function stillMissing(requests: readonly WaitingForConnection[]): ConnectionCallFailure {
  const [first] = requests;
  return {
    code: 'connection-missing',
    ...(first !== undefined && { connection: first.name }),
    message: `${first?.appName ?? 'A connection this call needs'} needs connecting before this call can run, so it didn't run.`,
  };
}

function notServed(needs: Readonly<Record<string, ConnectionNeed>>): ConnectionCallFailure {
  const [name] = Object.keys(needs).sort();
  const app = name === undefined ? undefined : needs[name]?.app;
  return {
    code: 'connection-app-missing',
    ...(name !== undefined && { connection: name }),
    message: `This call needs a connection to ${app}, and this server doesn't serve connections, so it didn't run.`,
  };
}

/** The resolver couldn't get a token just now: the call fails with its code. */
function renewFailureOf(cause: unknown): ConnectionCallFailure | undefined {
  if (!isConnectionRenewError(cause)) return undefined;
  return { code: cause.code, connection: cause.connection, message: cause.message };
}

/**
 * The connections the gate decided on for the needs the call named a set's
 * member for, by their ids; none when it named none.
 */
function decidedAccounts(
  decided: Readonly<Record<string, RecordedConnection>>,
): Readonly<Record<string, string>> | undefined {
  const accounts: Record<string, string> = {};
  for (const [name, seen] of Object.entries(decided)) {
    if (seen.pick?.by === 'named') accounts[name] = seen.connectionId;
  }
  return Object.keys(accounts).length > 0 ? accounts : undefined;
}
