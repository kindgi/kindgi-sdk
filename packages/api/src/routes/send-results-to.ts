// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import {
  SCHEDULE_RESULT_EVENTS,
  type ScheduleResultEvent,
  type ScheduleResultTarget,
  type TriggerOwner,
} from '@kindgi/runtime';
import type { DestinationId, ProjectId, TenantId } from '@kindgi/types';

import type { DestinationBinding, ResultEmail } from '../destination-binding.js';
import { UUID_RE } from './uuid-param.js';

/** The most places one schedule's results go. */
export const SEND_RESULTS_TO_MAX = 5;

/** `sendResultsTo` as a body names it: absent, a list, or why it's refused. */
export type ParsedSendResultsTo =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly value: readonly ScheduleResultTarget[] }
  | { readonly kind: 'err'; readonly message: string };

/**
 * Reads a schedule body's `sendResultsTo`: at most five `{ to, on? }`, each
 * `to` a destination id or `me`, named once; `on` defaults to every event.
 * `[]` is a list too: on a PATCH it clears the field.
 */
export function parseSendResultsTo(body: Record<string, unknown>): ParsedSendResultsTo {
  if (!('sendResultsTo' in body)) return { kind: 'absent' };
  const raw = body.sendResultsTo;
  if (!Array.isArray(raw)) {
    return { kind: 'err', message: '`sendResultsTo` must be a list of `{ to, on }`' };
  }
  if (raw.length > SEND_RESULTS_TO_MAX) {
    return {
      kind: 'err',
      message: `\`sendResultsTo\` takes at most ${SEND_RESULTS_TO_MAX} places`,
    };
  }
  const seen = new Set<string>();
  const value: ScheduleResultTarget[] = [];
  for (const [i, item] of raw.entries()) {
    const parsed = parseTarget(item, `sendResultsTo[${i}]`);
    if (typeof parsed === 'string') return { kind: 'err', message: parsed };
    if (seen.has(parsed.to)) {
      return { kind: 'err', message: `\`sendResultsTo[${i}].to\` ("${parsed.to}") is named twice` };
    }
    seen.add(parsed.to);
    value.push(parsed);
  }
  return { kind: 'ok', value };
}

/** One `{ to, on? }`, or why it's refused. */
function parseTarget(item: unknown, at: string): ScheduleResultTarget | string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return `\`${at}\` must be an object: \`{ to, on }\``;
  }
  const fields = item as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => key !== 'to' && key !== 'on');
  if (unknown !== undefined) return `\`${at}\` has an unknown field \`${unknown}\``;
  const { to } = fields;
  if (typeof to !== 'string' || (to !== 'me' && !UUID_RE.test(to))) {
    return `\`${at}.to\` must be a destination id (a UUID) or \`me\``;
  }
  const on = parseOn(fields.on, `${at}.on`);
  if (typeof on === 'string') return on;
  // One spelling per id, so a case change is neither a second place nor a new version.
  return { to: (to === 'me' ? to : to.toLowerCase()) as DestinationId | 'me', on };
}

/** `on`: absent for every event, or a non-empty list of them, each named once. */
function parseOn(raw: unknown, at: string): readonly ScheduleResultEvent[] | string {
  if (raw === undefined) return SCHEDULE_RESULT_EVENTS;
  const named = `one or more of: ${SCHEDULE_RESULT_EVENTS.join(', ')}`;
  if (!Array.isArray(raw) || raw.length === 0) return `\`${at}\` must list ${named}`;
  const known: readonly string[] = SCHEDULE_RESULT_EVENTS;
  const bad = raw.find((event) => typeof event !== 'string' || !known.includes(event));
  if (bad !== undefined) return `\`${at}\` has ${JSON.stringify(bad)}: it must list ${named}`;
  return [...new Set(raw as ScheduleResultEvent[])];
}

/**
 * Why a schedule can't send its results where `targets` say, or
 * `undefined` when it can: each destination must exist (not removed) and
 * be one the schedule's project may use, and `me` needs an owner who is a
 * person, since it is their own email, and a deployment that sends email
 * (`resultEmail`; absent: it does).
 */
export async function sendResultsToProblem(
  destinations: Pick<DestinationBinding, 'get'> | undefined,
  tenantId: TenantId,
  projectId: ProjectId | undefined,
  owner: TriggerOwner,
  targets: readonly ScheduleResultTarget[],
  resultEmail?: ResultEmail,
): Promise<string | undefined> {
  // A refused destination names `me` instead only where `me` would be taken.
  const meTaken = meProblem(owner, 0, resultEmail) === undefined;
  for (const [i, target] of targets.entries()) {
    const problem =
      target.to === 'me'
        ? meProblem(owner, i, resultEmail)
        : await destinationProblem(destinations, tenantId, projectId, target.to, i, meTaken);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/**
 * Why `owner` can't own a schedule whose results go to `targets`, or
 * `undefined`: `me` is its owner's own email, which a service account
 * doesn't have. An owner change is checked with it, as a save is.
 */
export function sendResultsToOwnerProblem(
  owner: TriggerOwner,
  targets: readonly ScheduleResultTarget[],
): string | undefined {
  const i = targets.findIndex((target) => target.to === 'me');
  return i === -1 || owner.kind === 'user'
    ? undefined
    : `\`sendResultsTo[${i}].to\` is \`me\`, its owner's own email, and a service account has none: change \`sendResultsTo\` with PATCH first`;
}

function meProblem(
  owner: TriggerOwner,
  i: number,
  resultEmail: ResultEmail | undefined,
): string | undefined {
  if (owner.kind !== 'user') {
    return `\`sendResultsTo[${i}].to\` is \`me\`, its owner's own email, but this schedule runs as a service account, which has none: name a destination instead`;
  }
  if (resultEmail !== undefined && !resultEmail.on) {
    return `\`sendResultsTo[${i}].to\` is \`me\`, its owner's own email, but this deployment sends no email: \`me\` needs \`${resultEmail.setting}\``;
  }
  return undefined;
}

async function destinationProblem(
  destinations: Pick<DestinationBinding, 'get'> | undefined,
  tenantId: TenantId,
  projectId: ProjectId | undefined,
  destinationId: DestinationId,
  i: number,
  meTaken: boolean,
): Promise<string | undefined> {
  if (destinations === undefined) {
    const no = `\`sendResultsTo[${i}].to\` names a destination, but this deployment has no destinations`;
    return meTaken ? `${no}: send to \`me\` instead` : no;
  }
  const found = await destinations.get({ tenantId, destinationId });
  if (found === null) {
    return `\`sendResultsTo[${i}].to\`: no destination with id "${destinationId as unknown as string}"`;
  }
  const allowed =
    found.projects === undefined || (projectId !== undefined && found.projects.includes(projectId));
  return allowed
    ? undefined
    : `\`sendResultsTo[${i}].to\`: destination "${found.name}" isn't for this schedule's project`;
}

/** Whether two lists send the same results to the same places, in any order. */
export function sameResultTargets(
  a: readonly ScheduleResultTarget[],
  b: readonly ScheduleResultTarget[],
): boolean {
  const key = (t: ScheduleResultTarget) => `${t.to}:${[...t.on].sort().join(',')}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

/** The wire form of a schedule's `sendResultsTo`. */
export function sendResultsToJson(
  targets: readonly ScheduleResultTarget[],
): readonly { to: string; on: readonly string[] }[] {
  return targets.map((t) => ({ to: t.to as string, on: [...t.on] }));
}
