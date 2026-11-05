// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import type { ProjectId } from '@kindgi/types';

import { statusFor, toWireError } from './errors.js';
import type {
  PlanCount,
  PlanLimit,
  PlanLimitsBinding,
  PlanLimitsInput,
  PlanOver,
  PlanRefused,
  PlanWarning,
} from './plan-limits-binding.js';
import type { AppEnv } from './types.js';

/** The seconds a `503 plan-count-busy` asks a client to wait: `database-busy`'s. */
export const PLAN_COUNT_BUSY_RETRY_AFTER_S = 5;

/**
 * A router's plan limits: the binding, and where a larger plan is
 * (`CreateAppInput.production.next`, `KINDGI_PRODUCTION_NEXT_URL`).
 */
export interface PlanGate {
  readonly limits: PlanLimitsBinding;
  readonly next?: string;
}

/** The routers' `PlanGate`, or none without a binding: nothing is counted then. */
export function planGateOf(
  limits: PlanLimitsBinding | undefined,
  next: string | undefined,
): PlanGate | undefined {
  if (limits === undefined) return undefined;
  return { limits, ...(next !== undefined && { next }) };
}

/** How a refusal reads: where it lands, and where a larger plan is. */
export interface PlanWords {
  /** Putting the project in production, rather than a write into it. */
  readonly goingLive?: boolean;
  /** Where to get a larger plan (`KINDGI_PRODUCTION_NEXT_URL`), when set. */
  readonly next?: string;
}

/**
 * What a write through the plan limits came to: an answer for the route
 * to give as it is (refused or busy, with `write` never run), or the
 * write's value with the `planWarning` its answer carries.
 */
export type PlanAdmitted<T> =
  | { readonly kind: 'answer'; readonly response: Response }
  | { readonly kind: 'done'; readonly value: T; readonly planWarning?: PlanWarning };

/**
 * Run a route's writes through `planLimits.admit`, or straight with no
 * binding: nothing is counted then. A refusal answers `403
 * plan-limit-reached`, and a count that couldn't be had in time `503
 * plan-count-busy` with `Retry-After`; `write` never ran for either. A
 * rejection (a read the binding needed failed) is the route's to answer as
 * a store failure, so it's left to throw.
 */
export async function admitPlan<T>(
  c: Context<AppEnv>,
  plan: PlanGate | undefined,
  input: PlanLimitsInput,
  write: () => Promise<T>,
  goingLive = false,
): Promise<PlanAdmitted<T>> {
  if (plan === undefined) return { kind: 'done', value: await write() };
  const admission = await plan.limits.admit(input, write);
  if (admission.kind === 'refused') {
    return {
      kind: 'answer',
      response: planRefusedAnswer(c, input, admission, wordsOf(plan, goingLive)),
    };
  }
  if (admission.kind === 'busy') return { kind: 'answer', response: planBusyAnswer(c) };
  return { kind: 'done', value: admission.value, ...planWarningField(admission.warning) };
}

/**
 * A dry check's plan answer: the refusal to give instead of the check's
 * own, or the `planWarning` to add to it. No binding: nothing to add.
 */
export async function checkPlan(
  c: Context<AppEnv>,
  plan: PlanGate | undefined,
  input: PlanLimitsInput,
  goingLive = false,
): Promise<PlanAdmitted<undefined>> {
  if (plan === undefined) return { kind: 'done', value: undefined };
  const checked = await plan.limits.check(input);
  if (checked.kind === 'refused') {
    return {
      kind: 'answer',
      response: planRefusedAnswer(c, input, checked, wordsOf(plan, goingLive)),
    };
  }
  return { kind: 'done', value: undefined, ...planWarningField(checked.warning) };
}

function wordsOf(plan: PlanGate, goingLive: boolean): PlanWords {
  return { ...(goingLive && { goingLive }), ...(plan.next !== undefined && { next: plan.next }) };
}

/** `{planWarning}` for an answer, only when some count is at its plan. */
export function planWarningField(warning: PlanWarning | undefined): {
  readonly planWarning?: PlanWarning;
} {
  if (warning === undefined) return {};
  const kept: { flows?: PlanCount; agents?: PlanCount } = {
    ...(warning.flows !== undefined && { flows: warning.flows }),
    ...(warning.agents !== undefined && { agents: warning.agents }),
  };
  return kept.flows === undefined && kept.agents === undefined ? {} : { planWarning: kept };
}

/** The `403 plan-limit-reached` answer: `write` never ran. */
export function planRefusedAnswer(
  c: Context<AppEnv>,
  input: PlanLimitsInput,
  refused: PlanRefused,
  words: PlanWords,
): Response {
  c.status(statusFor('plan-limit-reached') as never);
  return c.json(
    toWireError(planRefusedError(input.projectId, refused, words), c.get('requestId') as string),
  );
}

/**
 * `plan-limit-reached` as an error with its details, for a route that
 * answers its errors itself: what `planRefusedAnswer` answers.
 */
export function planRefusedError(
  projectId: ProjectId | undefined,
  refused: PlanRefused,
  words: PlanWords,
): { readonly code: 'plan-limit-reached'; readonly message: string } & Readonly<
  Record<string, unknown>
> {
  const [first] = refused.over;
  return {
    code: 'plan-limit-reached',
    message: planRefusedMessage(refused.over, words),
    ...(projectId !== undefined && { projectId: projectId as unknown as string }),
    ...overDetail(first),
    over: refused.over.map(overDetail),
    newIds: { flows: [...refused.newIds.flows], agents: [...refused.newIds.agents] },
    ...(words.next !== undefined && { next: words.next }),
  };
}

/** The `503 plan-count-busy` answer: nothing ran, so a retry is safe. */
export function planBusyAnswer(c: Context<AppEnv>): Response {
  c.header('Retry-After', String(PLAN_COUNT_BUSY_RETRY_AFTER_S));
  c.status(statusFor('plan-count-busy') as never);
  return c.json(toWireError(planBusyError(), c.get('requestId') as string));
}

/**
 * `plan-count-busy` as an error, for a route that answers its errors
 * itself; it sends `Retry-After` (`PLAN_COUNT_BUSY_RETRY_AFTER_S`) with it.
 */
export function planBusyError(): { readonly code: 'plan-count-busy'; readonly message: string } {
  return {
    code: 'plan-count-busy',
    message:
      'Counting the agents and flows in production took too long, so none were added. Try again after Retry-After.',
  };
}

/** One count over, as the details carry it: numbers only when this tenant may see them. */
function overDetail(over: PlanOver): {
  readonly limit: PlanLimit;
  readonly adding: number;
  readonly plan?: number;
  readonly most?: number;
  readonly inUse?: number;
} {
  return {
    limit: over.limit,
    adding: over.adding,
    ...(over.numbers !== undefined && {
      plan: over.numbers.plan,
      most: over.numbers.most,
      inUse: over.numbers.inUse,
    }),
  };
}

/**
 * The refusal's words. With the numbers: what the write adds, the most the
 * key runs, the plan's own number, and how many run. Without them (they
 * count other tenants too): that it's past what the key allows, and who
 * to ask.
 */
export function planRefusedMessage(over: readonly PlanOver[], words: PlanWords): string {
  const adds = over.map((o) => counted(o.adding, o.limit)).join(' and ');
  const lead =
    words.goingLive === true
      ? `Putting this project in production adds ${adds}`
      : `This adds ${adds} to production`;
  const numbers = over.map((o) => o.numbers);
  if (!numbers.every((n): n is PlanCount => n !== undefined)) {
    const ask =
      words.next !== undefined
        ? `For a larger plan: ${words.next}.`
        : 'Ask whoever runs this Kindgi for a larger plan.';
    return `${lead}, past what this runtime's license key allows. ${ask} What runs keeps running.`;
  }
  const larger =
    words.next !== undefined
      ? `get a larger plan: ${words.next}`
      : 'renew the key on a larger plan';
  const tail = `What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or ${larger}.`;
  const [one] = numbers;
  if (numbers.length === 1 && one !== undefined) {
    return `${lead}, and this runtime's license key runs at most ${one.most}: its plan's ${one.plan}, and a margin. ${one.inUse} ${one.inUse === 1 ? 'runs' : 'run'} in production now. ${tail}`;
  }
  const most = over.map((o, i) => counted(numbers[i]?.most ?? 0, o.limit)).join(' and ');
  const plans = numbers.map((n) => String(n.plan)).join(' and ');
  const inUse = over.map((o, i) => counted(numbers[i]?.inUse ?? 0, o.limit)).join(' and ');
  return `${lead}, and this runtime's license key runs at most ${most}: its plan's ${plans}, and a margin. ${inUse} run in production now. ${tail}`;
}

/** `1 agent`, `2 flows`. */
function counted(n: number, limit: PlanLimit): string {
  const noun = limit === 'flows' ? 'flow' : 'agent';
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
