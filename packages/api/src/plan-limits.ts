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
  PlanScope,
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
  readonly scope?: PlanScope;
  readonly plan?: number;
  readonly most?: number;
  readonly inUse?: number;
} {
  return {
    limit: over.limit,
    adding: over.adding,
    ...(over.scope !== undefined && { scope: over.scope }),
    ...(over.numbers !== undefined && {
      plan: over.numbers.plan,
      most: over.numbers.most,
      inUse: over.numbers.inUse,
    }),
  };
}

/** Whose numbers a count is held to, as the words name them. */
interface RowWords {
  readonly whose: string;
  /** `its plan's 10`, `its limits of 3 and 10`. */
  readonly its: (plans: readonly number[]) => string;
  /** The last way to make room. */
  readonly larger: (next: string | undefined) => string;
}

const KEY_ROW: RowWords = {
  whose: "this runtime's license key",
  its: (plans) => `its plan's ${plans.join(' and ')}`,
  larger: (next) =>
    next !== undefined ? `get a larger plan: ${next}` : 'renew the key on a larger plan',
};

const TENANT_ROW: RowWords = {
  whose: 'this workspace',
  its: (plans) => `${plans.length === 1 ? 'its limit of' : 'its limits of'} ${plans.join(' and ')}`,
  larger: (next) =>
    next !== undefined
      ? `move to a larger plan: ${next}`
      : 'ask whoever runs this Kindgi for a larger limit',
};

/**
 * The refusal's words. With the numbers: what the write adds, the most
 * the key or the workspace runs, the plan's own number, and how many run.
 * Without the key's (they count other tenants too): that it's past what
 * the key allows, and who to ask. A workspace's own limits always carry
 * their numbers. When one count is over the key's and the other over the
 * workspace's, each gets its own sentence.
 */
export function planRefusedMessage(over: readonly PlanOver[], words: PlanWords): string {
  const adds = over.map((o) => counted(o.adding, o.limit)).join(' and ');
  const lead =
    words.goingLive === true
      ? `Putting this project in production adds ${adds}`
      : `This adds ${adds} to production`;
  const tenant = over.filter((o) => o.scope === 'tenant');
  const key = over.filter((o) => o.scope !== 'tenant');
  const keyShown = key.every((o) => o.numbers !== undefined);
  const tail = (larger: string) =>
    `What runs keeps running, and changes to it go through. To make room, unregister one that runs in production, take a project out of production, or ${larger}.`;
  if (tenant.length > 0 && key.length > 0) {
    const larger =
      words.next !== undefined
        ? `get a larger plan: ${words.next}`
        : keyShown
          ? 'renew the key on a larger plan, and ask whoever runs this Kindgi for a larger limit'
          : 'ask whoever runs this Kindgi for a larger limit and plan';
    const keySentence = keyShown
      ? upper(heldTo(key, KEY_ROW, true))
      : `For ${key.map((o) => o.limit).join(' and ')}, that's past what this runtime's license key allows.`;
    return `${lead}. ${upper(heldTo(tenant, TENANT_ROW, true))} ${keySentence} ${tail(larger)}`;
  }
  if (tenant.length === 0 && !keyShown) {
    const ask =
      words.next !== undefined
        ? `For a larger plan: ${words.next}.`
        : 'Ask whoever runs this Kindgi for a larger plan.';
    return `${lead}, past what this runtime's license key allows. ${ask} What runs keeps running.`;
  }
  const row = tenant.length > 0 ? TENANT_ROW : KEY_ROW;
  return `${lead}, and ${heldTo(over, row, over.length > 1)} ${tail(row.larger(words.next))}`;
}

/**
 * `this workspace runs at most 12: its limit of 10, and a margin. 11 run in
 * production now.`, the counts named when `named` (two counts, or a
 * sentence of its own). Each of `over` carries its numbers.
 */
function heldTo(over: readonly PlanOver[], row: RowWords, named: boolean): string {
  const numbers = over.map((o) => o.numbers ?? { plan: 0, most: 0, inUse: 0 });
  const most = named
    ? over.map((o, i) => counted(numbers[i]?.most ?? 0, o.limit)).join(' and ')
    : String(numbers[0]?.most ?? 0);
  const inUse = named
    ? over.map((o, i) => counted(numbers[i]?.inUse ?? 0, o.limit)).join(' and ')
    : String(numbers[0]?.inUse ?? 0);
  const runs = over.length === 1 && numbers[0]?.inUse === 1 ? 'runs' : 'run';
  return `${row.whose} runs at most ${most}: ${row.its(numbers.map((n) => n.plan))}, and a margin. ${inUse} ${runs} in production now.`;
}

/** The sentence's first letter in upper case. */
function upper(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** `1 agent`, `2 flows`. */
function counted(n: number, limit: PlanLimit): string {
  const noun = limit === 'flows' ? 'flow' : 'agent';
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
