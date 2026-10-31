// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a correction goes, and how it may move: the rule that sorts it when
 * it's saved, and the changes a person may make to its status and sorting.
 * Both are pure, so the route, a store and a surface agree on them.
 */

import type {
  CorrectedAnswerItem,
  Correction,
  CorrectionFixedIn,
  CorrectionLink,
  CorrectionMadeBy,
  CorrectionOutcomeChange,
  CorrectionReopenedHow,
  CorrectionReopenedIn,
  CorrectionSorted,
  CorrectionSortedTo,
  CorrectionStatus,
  CorrectionStatusNote,
  Verdict,
} from './correction-binding.js';

/** Where a correction is when it's saved. */
export interface SortedAtSave {
  readonly status: CorrectionStatus;
  readonly sortedTo?: CorrectionSortedTo;
  readonly sorted?: CorrectionSorted;
  readonly fixedIn?: CorrectionFixedIn;
}

/**
 * The rule at save:
 * - an end user's correction (`participantId`, and not an expert's) stays
 *   open and unsorted until a person sorts it;
 * - `decisions: 'wrong'` goes to the agent's owner (`with-owner`): a change
 *   to what the agent does may loosen a limit, which only the owner decides;
 * - a wrong answer (or a wrong item of it) goes to Improve, open;
 * - nothing wrong is `fixed` as `recorded-right`: there's nothing to fix.
 */
export function sortAtSave(
  correction: {
    readonly decisions?: Verdict;
    readonly answer?: Verdict;
    readonly items?: readonly CorrectedAnswerItem[];
    readonly participantId?: string;
    /** It names a restricted group, and its author met it. */
    readonly expert: boolean;
  },
  by: CorrectionMadeBy,
  at: string,
): SortedAtSave {
  if (correction.participantId !== undefined && !correction.expert) return { status: 'open' };
  const byRule: CorrectionSorted = { by: { kind: 'rule' }, at };
  if (correction.decisions === 'wrong') {
    return { status: 'with-owner', sortedTo: 'owner', sorted: byRule };
  }
  const wrongAnswer =
    correction.answer === 'wrong' || (correction.items ?? []).some((i) => i.verdict === 'wrong');
  if (wrongAnswer) return { status: 'open', sortedTo: 'improve', sorted: byRule };
  return { status: 'fixed', fixedIn: { how: 'recorded-right', by, at } };
}

/** The statuses a person may set by hand. `fixed` is set only by a pin or a deploy. */
export const STATUSES_SET_BY_HAND = ['open', 'being-fixed', 'wont-fix'] as const;
export type StatusSetByHand = (typeof STATUSES_SET_BY_HAND)[number];

/** A person's change: a re-sort, a status, or both (the re-sort first). */
export interface CorrectionChange {
  readonly sortedTo?: CorrectionSortedTo;
  readonly status?: CorrectionStatus;
  /** With `status: 'being-fixed'`: the work fixing it. */
  readonly link?: CorrectionLink;
  /** Required for `wont-fix`; with `open`, why it went back. Otherwise the re-sort's reason. */
  readonly reason?: string;
}

/** What the change writes: `null` clears a field. */
export interface PlannedChange {
  readonly status?: CorrectionStatus;
  readonly sortedTo?: CorrectionSortedTo;
  readonly sorted?: CorrectionSorted;
  readonly link?: CorrectionLink | null;
  readonly statusNote?: CorrectionStatusNote | null;
  /** `null` when the status leaves `fixed`: `fixedIn` is there only while it's fixed. */
  readonly fixedIn?: null;
  /** `null` when a person changes the status of one a test run reopened: the reopening is over. */
  readonly reopenedIn?: null;
}

export type PlannedChangeOutcome =
  | { readonly kind: 'ok'; readonly change: PlannedChange }
  /** The change table doesn't allow it from `from`. */
  | { readonly kind: 'not-allowed'; readonly from: CorrectionStatus; readonly to: CorrectionStatus }
  | { readonly kind: 'bad-input'; readonly message: string };

const RESORTABLE: readonly CorrectionStatus[] = ['open', 'being-fixed', 'with-owner'];
const SET_FROM: Readonly<Record<StatusSetByHand, readonly CorrectionStatus[]>> = {
  'being-fixed': ['open', 'with-owner'],
  open: ['being-fixed', 'wont-fix'],
  'wont-fix': ['open', 'being-fixed', 'with-owner', 'fixed', 'wont-fix'],
};

/**
 * The change table (a person's PATCH):
 * - re-sorting, from `open`, `being-fixed` or `with-owner`: to `owner` sets
 *   `with-owner`, and away from `owner` sets `open`; recorded as sorted by
 *   the caller (a user or a service);
 * - `being-fixed` from `open` or `with-owner`, with a link;
 * - `open` from `being-fixed` or `wont-fix`, which is `with-owner` for one
 *   sorted to the owner, as re-sorting to the owner is;
 * - `wont-fix` from anything but `removed`, with a reason, which clears
 *   `fixedIn` when it was `fixed`.
 * A status set by hand clears `reopenedIn` and the `fixedIn` kept beside it;
 * a re-sort alone keeps both.
 * Anything else is `not-allowed`.
 */
export function planChange(
  current: {
    readonly status: CorrectionStatus;
    readonly sortedTo?: CorrectionSortedTo;
    readonly reopenedIn?: CorrectionReopenedIn;
  },
  change: CorrectionChange,
  by: CorrectionMadeBy,
  at: string,
): PlannedChangeOutcome {
  if (change.sortedTo === undefined && change.status === undefined) {
    return { kind: 'bad-input', message: 'A change sets sortedTo, status, or both.' };
  }
  if (change.link !== undefined && change.status !== 'being-fixed') {
    return { kind: 'bad-input', message: 'link goes with status: "being-fixed".' };
  }
  let status = current.status;
  let planned: PlannedChange = {};
  if (change.sortedTo !== undefined) {
    const wasOwner = current.sortedTo === 'owner' || status === 'with-owner';
    const to = change.sortedTo === 'owner' ? 'with-owner' : wasOwner ? 'open' : status;
    if (!RESORTABLE.includes(status)) return { kind: 'not-allowed', from: status, to };
    const reason = change.status === undefined ? change.reason : undefined;
    planned = {
      sortedTo: change.sortedTo,
      sorted: { by: { kind: by.kind, id: by.id }, ...(reason !== undefined && { reason }), at },
      ...(to !== status && { status: to }),
      // A link names the work fixing it, so it goes when it stops being fixed.
      ...(status === 'being-fixed' && to !== 'being-fixed' && { link: null }),
    };
    status = to;
  }
  if (change.status === undefined) return { kind: 'ok', change: planned };
  const to = change.status;
  const reopenedIn = endsReopening(current);
  const from = (SET_FROM as Readonly<Record<string, readonly CorrectionStatus[]>>)[to];
  if (from === undefined || !from.includes(status)) {
    return { kind: 'not-allowed', from: current.status, to };
  }
  if (to === 'being-fixed') {
    if (change.link === undefined) {
      return {
        kind: 'bad-input',
        message: 'status: "being-fixed" needs a link: a URL, ir-… or sc-….',
      };
    }
    return { kind: 'ok', change: { ...planned, status: to, link: change.link, ...reopenedIn } };
  }
  if (to === 'wont-fix' && change.reason === undefined) {
    return { kind: 'bad-input', message: 'status: "wont-fix" needs a reason.' };
  }
  const note =
    change.reason === undefined
      ? null
      : { text: change.reason, by: { kind: by.kind, id: by.id }, at };
  const lands =
    to === 'open' && (planned.sortedTo ?? current.sortedTo) === 'owner' ? 'with-owner' : to;
  return {
    kind: 'ok',
    change: {
      ...planned,
      status: lands,
      link: null,
      statusNote: note,
      ...(status === 'fixed' && { fixedIn: null }),
      ...reopenedIn,
    },
  };
}

/**
 * A status set by hand ends a test run's reopening, when it has one:
 * `reopenedIn` goes, with the `fixedIn` kept beside it.
 */
function endsReopening(current: { readonly reopenedIn?: CorrectionReopenedIn }): {
  readonly reopenedIn?: null;
  readonly fixedIn?: null;
} {
  return current.reopenedIn === undefined ? {} : { reopenedIn: null, fixedIn: null };
}

/** A project starting to run another version, and what a test run of that version found. */
export interface RunOutcomeInput {
  /** The version the run checked: the one the project now runs. */
  readonly version: string;
  /** How the project came to run it: its newest pin change, or Latest moving (`reopenedIn.how`). */
  readonly how: CorrectionReopenedHow;
  /**
   * What the project follows now: a pin, or Latest (`fixedIn.how`). After an
   * unpin, it's `pin` under a wider pin and `latest` when it follows Latest.
   */
  readonly follows: 'pin' | 'latest';
  /** Who made the newest pin change; absent when Latest moved. */
  readonly by?: CorrectionMadeBy;
  /** When the project started running it, ISO-8601. */
  readonly at: string;
  /** The project's corrections whose cases the run checked, as they are now. */
  readonly corrections: readonly Pick<
    Correction,
    'id' | 'status' | 'sortedTo' | 'link' | 'statusNote'
  >[];
  /** Whether the run passed each correction's case, by correction id. */
  readonly passed: ReadonlyMap<string, boolean>;
}

export interface RunOutcomePlan {
  /** The corrections it makes `fixed`. */
  readonly fixed: readonly string[];
  /** The `fixed` corrections it reopens. */
  readonly reopened: readonly string[];
  readonly changes: readonly CorrectionOutcomeChange[];
}

/** Statuses a passing case makes `fixed`. */
const FIXED_BY_A_PASS: readonly CorrectionStatus[] = ['open', 'being-fixed', 'with-owner'];

/**
 * What a test run of the version a project now runs does to the project's
 * corrections (each with an active case the run checked):
 * - a pass makes an `open`, `being-fixed` or `with-owner` one `fixed`, with
 *   `fixedIn` naming the version and what the project follows (`follows`),
 *   and ends a reopening before. A `fixed` one keeps its first `fixedIn`.
 * - a fail reopens a `fixed` one, with `reopenedIn` beside its `fixedIn`:
 *   `open`, or `with-owner` for one sorted to the owner, as a person
 *   reopening it would.
 * Either way the status's link and a person's note go with the status
 * before. Anything else is unchanged, and so is a correction the run
 * didn't check.
 */
export function planRunOutcome(input: RunOutcomeInput): RunOutcomePlan {
  const { version, how, by, at } = input;
  const fixedIn: CorrectionFixedIn = {
    version,
    how: input.follows,
    ...(by !== undefined && { by }),
    at,
  };
  const reopenedIn: CorrectionReopenedIn = { version, how, ...(by !== undefined && { by }), at };
  const fixed: string[] = [];
  const reopened: string[] = [];
  const changes: CorrectionOutcomeChange[] = [];
  for (const c of input.corrections) {
    const change = outcomeChange(c, input.passed.get(c.id), fixedIn, reopenedIn);
    if (change === undefined) continue;
    (change.status === 'fixed' ? fixed : reopened).push(c.id);
    changes.push(change);
  }
  return { fixed, reopened, changes };
}

/** One correction's change from a pass or a fail; `undefined` when it stays as it is. */
function outcomeChange(
  c: RunOutcomeInput['corrections'][number],
  passed: boolean | undefined,
  fixedIn: CorrectionFixedIn,
  reopenedIn: CorrectionReopenedIn,
): CorrectionOutcomeChange | undefined {
  const fixes = passed === true && FIXED_BY_A_PASS.includes(c.status);
  if (!fixes && !(passed === false && c.status === 'fixed')) return undefined;
  const status: CorrectionStatus = fixes ? 'fixed' : c.sortedTo === 'owner' ? 'with-owner' : 'open';
  return {
    correctionId: c.id,
    status,
    ...(fixes && { fixedIn }),
    reopenedIn: fixes ? null : reopenedIn,
    ...(c.link !== undefined && { link: null }),
    ...(c.statusNote !== undefined && { statusNote: null }),
  };
}

/** A link from its wire form: a URL is a pull request, `ir-…` an Improve run, `sc-…` a suggested change. */
export function parseCorrectionLink(raw: string): CorrectionLink | undefined {
  if (/^ir-[A-Za-z0-9_-]+$/.test(raw)) return { kind: 'improve-run', id: raw };
  if (/^sc-[A-Za-z0-9_-]+$/.test(raw)) return { kind: 'suggested-change', id: raw };
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? { kind: 'pull-request', url: raw }
      : undefined;
  } catch {
    return undefined;
  }
}
