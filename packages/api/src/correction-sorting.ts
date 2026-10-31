// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a correction goes, and how it may move: the rule that sorts it when
 * it's saved, and the changes a person may make to its status and sorting.
 * Both are pure, so the route, a store and a surface agree on them.
 */

import type {
  CorrectedAnswerItem,
  CorrectionFixedIn,
  CorrectionLink,
  CorrectionMadeBy,
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
 *   open and unsorted until a person sorts it, unless the project sorts end
 *   users' corrections (`sortEndUserCorrections`): then the rules below
 *   sort it like the others;
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
    /** The project's `sortEndUserCorrections`. */
    readonly sortEndUserCorrections?: boolean;
  },
  by: CorrectionMadeBy,
  at: string,
): SortedAtSave {
  const endUser = correction.participantId !== undefined && !correction.expert;
  if (endUser && correction.sortEndUserCorrections !== true) return { status: 'open' };
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
 * Anything else is `not-allowed`.
 */
export function planChange(
  current: { readonly status: CorrectionStatus; readonly sortedTo?: CorrectionSortedTo },
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
  const from = (SET_FROM as Readonly<Record<string, readonly CorrectionStatus[]>>)[to];
  if (from === undefined || !from.includes(status)) {
    return { kind: 'not-allowed', from: current.status, to };
  }
  if (to === 'being-fixed') {
    if (change.link === undefined) {
      return {
        kind: 'bad-input',
        message: 'status: "being-fixed" needs a link: a URL, ir-<its id> or sc-<its id>.',
      };
    }
    return { kind: 'ok', change: { ...planned, status: to, link: change.link } };
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
    },
  };
}

const IMPROVE_RUN_LINK = /^ir-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const SUGGESTED_CHANGE_LINK =
  /^sc-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * A link from its wire form: a URL is a pull request, `ir-` and an id an
 * Improve run, `sc-` and an id a suggested change. The link keeps the id
 * alone, as the Improve run's and suggested change's routes take it.
 */
export function parseCorrectionLink(raw: string): CorrectionLink | undefined {
  const run = IMPROVE_RUN_LINK.exec(raw)?.[1];
  if (run !== undefined) return { kind: 'improve-run', id: run.toLowerCase() };
  const change = SUGGESTED_CHANGE_LINK.exec(raw)?.[1];
  if (change !== undefined) return { kind: 'suggested-change', id: change.toLowerCase() };
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? { kind: 'pull-request', url: raw }
      : undefined;
  } catch {
    return undefined;
  }
}
