// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a run waits for: the answer `kindgi runs resume` gives (T272).
 *
 * A run resumes on its own once what it waits for happens, so the
 * command says what that is:
 * - an approval: which one, and the command that decides it;
 * - the runtime: a queued start, a child run, a scheduled retry, a lease
 *   another run holds, or a wait this runtime can't attribute;
 * - nothing: the run is running or finished.
 *
 * A runtime from 0.1.6 on answers it with the run: `GET /v1/runs/{runId}`'s
 * `waitingFor` on a suspended run, used as it is. Before that, it's read
 * here from the run's status, its journal's open waits (`wait.suspended`
 * with no `wait.resumed` / `wait.cancelled` after it), and the approvals
 * linked to those waits (`GET /v1/approvals?waitTokenId=`). Each answer
 * has its own exit code; a later "hold" feature takes 5.
 */

/** The exit code of each answer. 1 and 2 stay the CLI's error and usage codes. */
export const RESUME_EXIT_CODES = {
  'not-waiting': 0,
  approval: 3,
  runtime: 4,
  /** Reserved: a run put on hold (a later feature). */
  held: 5,
} as const;

export interface JournalEntry {
  readonly sequence: number;
  readonly kind: string;
  readonly nodeId?: string;
  readonly payload?: unknown;
  readonly timestamp: string;
}

export interface WaitingApproval {
  readonly id: string;
  readonly title?: string;
  readonly requiredRole: string;
  readonly status: string;
  /** The wait it's linked to (read here; not on `waitingFor`). */
  readonly waitTokenId?: string;
  /** For a tool call held for review: which tool and call (from `waitingFor`). */
  readonly tool?: { readonly id: string; readonly version: string; readonly callId: string };
}

export type RuntimeWait =
  | { readonly what: 'queued' }
  | {
      readonly what: 'child-run';
      readonly childRunId: string;
      readonly childStatus?: string;
      readonly timesOutAt?: string;
    }
  | {
      readonly what: 'retry';
      readonly nodeId: string;
      readonly attempt: number;
      readonly at: string;
    }
  | {
      readonly what: 'lease';
      readonly nodeId: string;
      readonly concurrencyKey: string;
      readonly holderRunId: string;
      readonly holderNodeId: string;
    }
  | {
      readonly what: 'decided-approval';
      readonly approvalId: string;
      readonly approvalStatus: string;
    }
  | { readonly what: 'unattributed'; readonly tokenId: string; readonly timesOutAt?: string }
  | { readonly what: 'no-open-wait' };

export type RunWaitAnswer =
  | { readonly kind: 'not-waiting'; readonly runId: string; readonly status: string }
  | {
      readonly kind: 'approval';
      readonly runId: string;
      readonly status: string;
      readonly approvals: readonly WaitingApproval[];
      /** Other things it waits on too (a child run, …). */
      readonly alsoWaitsOn: readonly RuntimeWait[];
    }
  | {
      readonly kind: 'runtime';
      readonly runId: string;
      readonly status: string;
      readonly waits: readonly RuntimeWait[];
      /** Set when the approvals couldn't be read, and why. */
      readonly approvalsUnavailable?: string;
    };

/** `GET /v1/runs/{runId}`'s `waitingFor` (a runtime from 0.1.6 on). */
export interface RunWaitingForWire {
  readonly approvals: readonly {
    readonly approvalId: string;
    readonly status: string;
    readonly requiredRole: string;
    readonly title?: string;
    readonly tool?: { readonly id: string; readonly version: string; readonly callId: string };
  }[];
  /** The same shapes as `RuntimeWait`. */
  readonly other: readonly unknown[];
}

/** What the answer reads; the CLI passes the client's calls. */
export interface RunWaitPort {
  readonly getRun: (runId: string) => Promise<{
    readonly id: string;
    readonly status: string;
    readonly waitingFor?: RunWaitingForWire;
  }>;
  readonly journalPage: (
    runId: string,
    since: number | undefined,
  ) => Promise<{ readonly data: readonly unknown[]; readonly hasMore: boolean }>;
  /**
   * The approvals linked to these waits. A runtime that doesn't filter
   * may answer others too; they're dropped. Throws when the caller may not
   * list approvals.
   */
  readonly approvalsFor: (tokenIds: readonly string[]) => Promise<readonly WaitingApproval[]>;
}

const FINISHED = new Set(['completed', 'failed', 'cancelled']);
/** An approval in one of these is still to be decided. */
const OPEN_APPROVAL = new Set(['pending', 'assigned', 'in_review', 'escalated']);
const MAX_JOURNAL_PAGES = 200;

export async function runWaitAnswer(port: RunWaitPort, runId: string): Promise<RunWaitAnswer> {
  const run = await port.getRun(runId);
  const status = run.status;
  if (FINISHED.has(status)) return { kind: 'not-waiting', runId, status };
  if (status === 'pending') return { kind: 'runtime', runId, status, waits: [{ what: 'queued' }] };
  if (status === 'suspended' && run.waitingFor !== undefined) {
    return fromWaitingFor(runId, status, run.waitingFor);
  }

  const journal = await readJournal(port, runId);
  if (status !== 'suspended') {
    const waits = [...pendingRetries(journal), ...deferredLeases(journal)];
    return waits.length > 0
      ? { kind: 'runtime', runId, status, waits }
      : { kind: 'not-waiting', runId, status };
  }

  return await suspendedAnswer(port, runId, status, openWaits(journal));
}

/** The runtime's own answer (`waitingFor`), in the same terms. */
function fromWaitingFor(runId: string, status: string, waiting: RunWaitingForWire): RunWaitAnswer {
  const other = waiting.other as readonly RuntimeWait[];
  if (waiting.approvals.length === 0) return { kind: 'runtime', runId, status, waits: other };
  const approvals: WaitingApproval[] = waiting.approvals.map((a) => ({
    id: a.approvalId,
    ...(a.title !== undefined && { title: a.title }),
    requiredRole: a.requiredRole,
    status: a.status,
    ...(a.tool !== undefined && { tool: a.tool }),
  }));
  return { kind: 'approval', runId, status, approvals, alsoWaitsOn: other };
}

/** A suspended run: what each of its open waits is for. */
async function suspendedAnswer(
  port: RunWaitPort,
  runId: string,
  status: string,
  open: readonly OpenWait[],
): Promise<RunWaitAnswer> {
  if (open.length === 0) {
    return { kind: 'runtime', runId, status, waits: [{ what: 'no-open-wait' }] };
  }
  const childWaits: RuntimeWait[] = [];
  const otherWaits: OpenWait[] = [];
  for (const wait of open) {
    const childRunId = childRunOf(wait.tokenId);
    if (childRunId === undefined) otherWaits.push(wait);
    else childWaits.push(await childWait(port, childRunId, wait));
  }
  if (otherWaits.length === 0) return { kind: 'runtime', runId, status, waits: childWaits };

  const tokens = otherWaits.map((w) => w.tokenId);
  let linked: readonly WaitingApproval[] = [];
  let approvalsUnavailable: string | undefined;
  try {
    // Kept only when linked to one of these waits: a runtime that ignores
    // the filter answers other approvals too.
    linked = (await port.approvalsFor(tokens)).filter(
      (a) => a.waitTokenId !== undefined && tokens.includes(a.waitTokenId),
    );
  } catch (err) {
    approvalsUnavailable = err instanceof Error ? err.message : String(err);
  }
  const openApprovals = linked.filter((a) => OPEN_APPROVAL.has(a.status));
  const decided: RuntimeWait[] = linked
    .filter((a) => !OPEN_APPROVAL.has(a.status))
    .map((a) => ({ what: 'decided-approval', approvalId: a.id, approvalStatus: a.status }));
  const unattributed: RuntimeWait[] = otherWaits
    .filter((w) => !linked.some((a) => a.waitTokenId === w.tokenId))
    .map((w) => ({
      what: 'unattributed',
      tokenId: w.tokenId,
      ...(w.timesOutAt !== undefined && { timesOutAt: w.timesOutAt }),
    }));
  const runtimeWaits = [...childWaits, ...decided, ...unattributed];
  if (openApprovals.length > 0) {
    return { kind: 'approval', runId, status, approvals: openApprovals, alsoWaitsOn: runtimeWaits };
  }
  return {
    kind: 'runtime',
    runId,
    status,
    waits: runtimeWaits,
    ...(approvalsUnavailable !== undefined && { approvalsUnavailable }),
  };
}

/** A wait on a child run, with the child's status when it can be read. */
async function childWait(
  port: RunWaitPort,
  childRunId: string,
  wait: OpenWait,
): Promise<RuntimeWait> {
  const child = await port.getRun(childRunId).catch(() => undefined);
  return {
    what: 'child-run',
    childRunId,
    ...(child !== undefined && { childStatus: child.status }),
    ...(wait.timesOutAt !== undefined && { timesOutAt: wait.timesOutAt }),
  };
}

/** The answer in sentences, for a person. */
export function runWaitText(answer: RunWaitAnswer): string {
  const { runId } = answer;
  if (answer.kind === 'not-waiting') {
    return answer.status === 'running'
      ? `Run ${runId} is running: it isn't waiting on anything, so there's nothing to resume.\n`
      : `Run ${runId} is ${answer.status}: it isn't waiting, so there's nothing to resume.\n`;
  }
  if (answer.kind === 'approval') {
    const lines = answer.approvals.map(
      (a) =>
        `Run ${runId} waits for approval ${a.id}${a.title !== undefined ? ` ("${a.title}")` : ''}${a.tool !== undefined ? `, holding call ${a.tool.callId} to ${a.tool.id}@${a.tool.version}` : ''}, for a ${a.requiredRole} reviewer or above. It continues once the approval is decided: kindgi approvals complete ${a.id} --decision=approve (or --decision=reject).`,
    );
    return `${[...lines, ...answer.alsoWaitsOn.map((w) => runtimeWaitText(runId, w))].join('\n')}\n`;
  }
  const lines = answer.waits.map((w) => runtimeWaitText(runId, w));
  if (answer.approvalsUnavailable !== undefined) {
    lines.push(`(The approvals couldn't be read: ${answer.approvalsUnavailable})`);
  }
  return `${lines.join('\n')}\n`;
}

function runtimeWaitText(runId: string, wait: RuntimeWait): string {
  const timesOut = (at: string | undefined) => (at !== undefined ? ` It times out at ${at}.` : '');
  switch (wait.what) {
    case 'queued':
      return `Run ${runId} is queued: the runtime starts it when a worker is free.`;
    case 'child-run':
      return `Run ${runId} waits for its child run ${wait.childRunId}${wait.childStatus !== undefined ? ` (${wait.childStatus})` : ''}; it continues when that run finishes.${timesOut(wait.timesOutAt)}`;
    case 'retry':
      return `Run ${runId} retries step ${wait.nodeId} (attempt ${wait.attempt}) at ${wait.at}.`;
    case 'lease':
      return `Run ${runId} waits for the lease "${wait.concurrencyKey}" for step ${wait.nodeId}, held by run ${wait.holderRunId} (step ${wait.holderNodeId}); it continues once that is released.`;
    case 'decided-approval':
      return `Run ${runId}'s approval ${wait.approvalId} is ${wait.approvalStatus}; the runtime continues the run.`;
    case 'unattributed':
      return `Run ${runId} waits on "${wait.tokenId}". This runtime can't say which approval, if any, that is: kindgi approvals list --status=pending lists the open ones.${timesOut(wait.timesOutAt)}`;
    case 'no-open-wait':
      return `Run ${runId} is suspended, but its journal shows no open wait; the runtime picks it up again.`;
  }
}

interface OpenWait {
  readonly tokenId: string;
  readonly timesOutAt?: string;
}

async function readJournal(port: RunWaitPort, runId: string): Promise<JournalEntry[]> {
  const entries: JournalEntry[] = [];
  let since: number | undefined;
  for (let page = 0; page < MAX_JOURNAL_PAGES; page += 1) {
    const got = await port.journalPage(runId, since);
    const data = got.data as JournalEntry[];
    entries.push(...data);
    const last = data[data.length - 1];
    if (!got.hasMore || last === undefined) break;
    since = last.sequence + 1;
  }
  return entries;
}

const payloadOf = (entry: JournalEntry): Record<string, unknown> =>
  typeof entry.payload === 'object' && entry.payload !== null
    ? (entry.payload as Record<string, unknown>)
    : {};

/** `wait.suspended` entries with no `wait.resumed` / `wait.cancelled` for their token after them. */
function openWaits(journal: readonly JournalEntry[]): OpenWait[] {
  const open = new Map<string, OpenWait>();
  for (const entry of journal) {
    const tokenId = payloadOf(entry).tokenId;
    if (typeof tokenId !== 'string') continue;
    if (entry.kind === 'wait.suspended') {
      const timeoutMs = payloadOf(entry).timeoutMs;
      const at = Date.parse(entry.timestamp);
      open.set(tokenId, {
        tokenId,
        ...(typeof timeoutMs === 'number' &&
          Number.isFinite(at) && { timesOutAt: new Date(at + timeoutMs).toISOString() }),
      });
    } else if (entry.kind === 'wait.resumed' || entry.kind === 'wait.cancelled') {
      open.delete(tokenId);
    }
  }
  return [...open.values()];
}

/** `child:<childRunId>:<sequence>`: the runtime's wait on a child run. */
function childRunOf(tokenId: string): string | undefined {
  const match = /^child:([^:]+):/.exec(tokenId);
  return match?.[1];
}

/** The last entry per node among `kinds`. */
function lastPerNode(journal: readonly JournalEntry[], kinds: ReadonlySet<string>) {
  const last = new Map<string, JournalEntry>();
  for (const entry of journal) {
    if (entry.nodeId !== undefined && kinds.has(entry.kind)) last.set(entry.nodeId, entry);
  }
  return last;
}

const STEP_OUTCOMES = ['step.started', 'step.completed', 'step.failed'];

/** Steps whose latest word is a scheduled retry: when each runs again. */
function pendingRetries(journal: readonly JournalEntry[]): RuntimeWait[] {
  const waits: RuntimeWait[] = [];
  const kinds = new Set(['step.retry-scheduled', ...STEP_OUTCOMES]);
  for (const [nodeId, entry] of lastPerNode(journal, kinds)) {
    if (entry.kind !== 'step.retry-scheduled') continue;
    const { attempt, nextDelayMs } = payloadOf(entry);
    const at = Date.parse(entry.timestamp) + (typeof nextDelayMs === 'number' ? nextDelayMs : 0);
    waits.push({
      what: 'retry',
      nodeId,
      attempt: typeof attempt === 'number' ? attempt : 1,
      at: Number.isFinite(at) ? new Date(at).toISOString() : entry.timestamp,
    });
  }
  return waits;
}

/** Steps whose latest word is a deferral on a lease another run holds. */
function deferredLeases(journal: readonly JournalEntry[]): RuntimeWait[] {
  const waits: RuntimeWait[] = [];
  const kinds = new Set(['step.concurrency-deferred', ...STEP_OUTCOMES]);
  for (const [nodeId, entry] of lastPerNode(journal, kinds)) {
    if (entry.kind !== 'step.concurrency-deferred') continue;
    const { concurrencyKey, holderRunId, holderNodeId } = payloadOf(entry);
    waits.push({
      what: 'lease',
      nodeId,
      concurrencyKey: String(concurrencyKey ?? ''),
      holderRunId: String(holderRunId ?? ''),
      holderNodeId: String(holderNodeId ?? ''),
    });
  }
  return waits;
}
