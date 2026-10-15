// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi feedback submit`, `status` and `withdraw`: sending `FEEDBACK.md`'s
 * entries to Kindgi's intake, hearing back, and taking a report back.
 *
 * - **submit** sends only what the person has seen. `--preview` prints the
 *   exact request, redacted, with its digest; at a terminal it asks; with no
 *   terminal (a coding agent) it needs `--yes=<digest>`, and refuses if the
 *   request changed since. `KINDGI_FEEDBACK_SUBMIT=off` turns it off.
 * - **status** asks about the reports sent, at most once a day each unless
 *   named, and never again once a report is fixed, won't be fixed, or was
 *   withdrawn, or, unless named, once the intake doesn't have it. A fixed
 *   one gets its `> **Fixed:**` line.
 * - **withdraw** takes reports back with the keys this machine kept. The
 *   intake clears their text at once.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { type DoctorReport, runDoctor } from '../commands/doctor.js';
import { commandResultFromThrown, stringFlag } from '../commands/helpers.js';
import { accessOrigin } from '../commands/license.js';
import type { CommandResult } from '../commands/types.js';
import type { CommandContext } from '../context.js';
import { loadLocalEnvSettings } from '../env/project-env.js';
import { UsageError } from '../errors.js';
import { pickHome } from '../key/paths.js';
import { renderJson } from '../output.js';
import {
  FEEDBACK_FILENAME,
  type FeedbackEntry,
  addSubmissions,
  markFixed,
  markWithdrawn,
  parseFeedback,
} from './entries.js';
import { type Asked, askStatus, sendReports, withdrawReports } from './intake.js';
import {
  type EntryPayload,
  FEEDBACK_REPORTS_PATH,
  FINAL_STATES,
  MAX_REPORT_IDS,
  REPORT_ID,
  type ReportState,
  type ReportStatus,
  type SubmitPayload,
  WITHDRAW_KEY,
} from './protocol.js';
import { readPackEnvEntries } from './redact.js';
import {
  type EntryProblem,
  type Platform,
  clientInfo,
  entryPayload,
  fitRequest,
  fitsOneRequest,
  pickEntries,
  serialize,
} from './report.js';
import {
  type FeedbackFiles,
  feedbackFiles,
  readKeys,
  readStatuses,
  updateKeys,
  updateStatuses,
} from './store.js';

/** Injectable seams, so tests run without the doctor's tools, a terminal or the real clock. */
export interface FeedbackSeam {
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  /** The checks sent with a report. Default: `kindgi doctor`'s, for the pack. */
  readonly doctor?: (dir: string) => Promise<DoctorReport>;
  readonly platform?: Platform;
  /** Whether a person is at a terminal to ask. Default: stdin and stderr are TTYs. */
  readonly interactive?: () => boolean;
  readonly confirm?: (question: string) => Promise<boolean>;
}

/** The env var that turns `submit` off for a machine or a team. */
export const SUBMIT_SWITCH = 'KINDGI_FEEDBACK_SUBMIT';

/** How long `status` waits before asking again about a report nobody named. */
const ASK_EVERY_MS = 24 * 60 * 60 * 1000;

export async function runSubmit(ctx: CommandContext): Promise<CommandResult> {
  try {
    const off = submitOff(ctx.env[SUBMIT_SWITCH]);
    if (off !== undefined) return { kind: 'error', stderr: off, exitCode: 1 };
    const prepared = await prepareReport(ctx);
    if (prepared.kind === 'stop') return prepared.result;
    const report = prepared.report;
    if (ctx.options.preview === true) {
      return result(
        ctx,
        report.preview,
        `Nothing was sent. This is exactly what would be, after redaction.${report.heldNote} Show it to the person; only after they say yes, send it: kindgi feedback submit${ctx.positionals.map((n) => ` ${n}`).join('')} --yes=${report.digest}\n`,
      );
    }
    const refused = await askConsent(ctx, report);
    if (refused !== undefined) return refused;
    return await deliver(ctx, report);
  } catch (err) {
    return commandResultFromThrown(err, ctx, 'feedback submit');
  }
}

/** A report ready to send: the request's bytes, their digest, and the preview of both. */
interface Prepared {
  readonly origin: string;
  readonly packDir: string;
  readonly home: string;
  readonly to: string;
  readonly sent: readonly EntryPayload[];
  readonly payload: SubmitPayload;
  readonly bytes: string;
  readonly digest: string;
  readonly preview: Readonly<Record<string, unknown>>;
  readonly held: number;
  readonly heldNote: string;
}

/** Pick the entries, redact them, check them against the caps, and add the environment. */
async function prepareReport(
  ctx: CommandContext,
): Promise<
  | { readonly kind: 'stop'; readonly result: CommandResult }
  | { readonly kind: 'ready'; readonly report: Prepared }
> {
  const origin = accessOrigin(ctx);
  const to = `${origin}${FEEDBACK_REPORTS_PATH}`;
  const packDir = packDirOf(ctx);
  const named = ctx.positionals;
  const picked = pickEntries(parseFeedback(await readFeedback(packDir, 'required')), named);
  if (picked.kind === 'unmatched') {
    throw new UsageError(
      `No entry in ${FEEDBACK_FILENAME} has the id or hash ${picked.selectors.join(', ')}.`,
    );
  }
  if (picked.picked.length === 0) {
    return {
      kind: 'stop',
      result: result(
        ctx,
        { to, reports: [] },
        `Nothing to send: every entry in ${FEEDBACK_FILENAME} was sent or is marked fixed. To send one again, name it: kindgi feedback submit <id>.\n`,
      ),
    };
  }

  const home = homeOf(ctx);
  const settings = await loadLocalEnvSettings(ctx, packDir);
  if (settings.kind === 'error') {
    throw new UsageError(
      `${settings.message} Nothing was sent: redaction needs the pack's env files.`,
    );
  }
  const redaction = {
    packDir,
    home,
    envEntries: await readPackEnvEntries(packDir, settings.localEnvFiles ?? []),
  };
  const payloads: { payload: EntryPayload; applied: readonly string[] }[] = [];
  const problems: EntryProblem[] = duplicateIds(picked.picked);
  for (const entry of picked.picked) {
    const one = entryPayload(entry, redaction);
    if (one.kind === 'problem') problems.push(one.problem);
    else payloads.push(one);
  }
  if (problems.length > 0) {
    return {
      kind: 'stop',
      result: {
        kind: 'error',
        stderr: `Nothing was sent: ${problems.length === 1 ? 'an entry needs' : 'entries need'} fixing in ${FEEDBACK_FILENAME} first.\n${problems.map((p) => `  ${p.entry}: ${p.problem}\n`).join('')}`,
        exitCode: 1,
      },
    };
  }

  const seam = ctx.feedbackSeam ?? {};
  const doctor = await (seam.doctor ?? ((dir: string) => runDoctor(ctx, dir)))(packDir);
  const client = clientInfo(doctor, seam.platform ?? thisPlatform());
  const all = payloads.map((p) => p.payload);
  if (named.length > 0 && !fitsOneRequest(client, all)) {
    throw new UsageError(
      `Those ${all.length} entries don't fit one report (at most 20 entries and 64 KiB): name fewer at once.`,
    );
  }
  // Named entries all go; otherwise the oldest that fit, and the rest wait.
  const { entries: sent, held } =
    named.length > 0 ? { entries: all, held: 0 } : fitRequest(client, all);
  const payload = { client, entries: sent };
  const { bytes, digest } = serialize(payload);
  const redacted = payloads
    .filter((p) => sent.includes(p.payload) && p.applied.length > 0)
    .map((p) => ({ entry: p.payload.entry, rules: p.applied }));
  return {
    kind: 'ready',
    report: {
      origin,
      packDir,
      home,
      to,
      sent,
      payload,
      bytes,
      digest,
      preview: { to, digest, redacted, ...(held > 0 && { held }), payload },
      held,
      heldNote:
        held > 0
          ? ` ${held} more ${held === 1 ? 'entry waits' : 'entries wait'} for the next run.`
          : '',
    },
  };
}

/**
 * The person's OK for exactly these bytes: `--yes` with their digest, or a
 * yes at the terminal. Without either, nothing is sent.
 */
async function askConsent(
  ctx: CommandContext,
  report: Prepared,
): Promise<CommandResult | undefined> {
  const yes = stringFlag(ctx, 'yes');
  if (yes !== undefined) {
    if (yes === report.digest) return undefined;
    return {
      kind: 'error',
      stderr: `Nothing was sent: the report changed since that preview, in an entry or in a check kindgi doctor runs (its digest is now ${report.digest}). Preview it again (--preview) and ask again.\n`,
      exitCode: 1,
    };
  }
  const seam = ctx.feedbackSeam ?? {};
  if (!(seam.interactive ?? isInteractive)()) {
    return {
      kind: 'error',
      stderr: `Nothing was sent: kindgi feedback submit sends only what the person has seen. Run it with --preview, show them the preview, and after they say yes, run it again with --yes=<the preview's digest>.\n`,
      exitCode: 1,
    };
  }
  process.stderr.write(`${JSON.stringify(report.preview, null, 2)}\n`);
  const ok = await (seam.confirm ?? confirmOnTerminal)(
    `Send this to Kindgi (${report.origin})?${report.heldNote} [y/N] `,
  );
  return ok ? undefined : { kind: 'error', stderr: 'Nothing was sent.\n', exitCode: 1 };
}

/**
 * Send it; keep the keys, then mark each entry submitted. Once the intake
 * has the reports, a failure to keep a key or mark an entry is said beside
 * that they arrived, never in place of it.
 */
async function deliver(ctx: CommandContext, report: Prepared): Promise<CommandResult> {
  const { to, digest, payload, held, heldNote } = report;
  // The keys must have somewhere to go before anything is sent.
  const files = feedbackFiles(report.home);
  await updateKeys(files, () => undefined);
  const asked = await sendReports(report.origin, report.bytes, report.sent, { fetch: ctx.fetch });
  if (asked.kind !== 'ok') {
    const maybe = asked.kind === 'failed' && asked.maybeReceived;
    return result(
      ctx,
      { to, digest, received: maybe ? 'maybe' : 'no', payload },
      `${submitFailure(asked)}\n`,
      1,
    );
  }
  const now = isoNow(ctx);
  const reports = asked.value;
  const keysLost = await whyFailed(() =>
    updateKeys(files, (keys) => {
      for (const r of reports) {
        keys[r.reportId] = { withdrawKey: r.withdrawKey, entry: r.entry, submittedAt: now };
      }
    }),
  );
  const path = join(report.packDir, FEEDBACK_FILENAME);
  let missing: readonly string[] = [];
  const unmarked = await whyFailed(async () => {
    const marked = addSubmissions(await readFile(path, 'utf8'), reports, now);
    await writeFile(path, marked.text, 'utf8');
    missing = marked.missing;
  });
  const n = reports.length;
  const notes = [
    keysLost === undefined && unmarked === undefined
      ? ` ${FEEDBACK_FILENAME} records each report id; the keys that withdraw them are in ${files.keys}, on this machine only.`
      : '',
    heldNote,
    missing.length > 0
      ? `\n  ${missing.join(', ')} left ${FEEDBACK_FILENAME} while it was sent, so ${missing.length === 1 ? 'it has' : 'they have'} no submitted line; the report ids are on stdout${keysLost === undefined ? ` and in ${files.keys}` : ''}.`
      : '',
    keysLost !== undefined
      ? `\n  ${n === 1 ? 'Its key' : 'Their keys'} couldn't be kept in ${files.keys} (${keysLost}), so ${n === 1 ? 'it' : 'they'} can't be withdrawn from this machine; Kindgi deletes ${n === 1 ? 'it' : 'them'} after 90 days.`
      : '',
    unmarked !== undefined
      ? `\n  ${FEEDBACK_FILENAME} couldn't be marked (${unmarked}): the report ids are on stdout. Sending those entries again makes a second report.`
      : '',
  ].join('');
  return result(
    ctx,
    {
      to,
      reports: reports.map((r) => ({ entry: r.entry, reportId: r.reportId })),
      ...(keysLost === undefined && { keys: files.keys }),
      ...(held > 0 && { held }),
    },
    `✓ sent ${n} ${n === 1 ? 'report' : 'reports'} to Kindgi.${notes}\n  Hear back with kindgi feedback status; take one back with kindgi feedback withdraw <id>.\n`,
    keysLost === undefined && unmarked === undefined ? 0 : 1,
  );
}

/** What stopped `step`, or `undefined` when it worked. */
async function whyFailed(step: () => Promise<void>): Promise<string | undefined> {
  try {
    await step();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function runStatus(ctx: CommandContext): Promise<CommandResult> {
  try {
    const origin = accessOrigin(ctx);
    const packDir = packDirOf(ctx);
    const text = await readFeedback(packDir, 'optional');
    const entries = parseFeedback(text ?? '');
    const named = ctx.positionals;
    const targets = reportsOf(entries, named, 'all');
    const files = feedbackFiles(homeOf(ctx));
    const statuses = await readStatuses(files);
    const nowMs = (ctx.feedbackSeam?.now ?? Date.now)();
    const toAsk = targets.reports.filter((t) => {
      const last = statuses[t.reportId];
      if (t.withdrawn || (last !== undefined && FINAL_STATES.has(last.state))) return false;
      if (named.length > 0 || last === undefined) return true;
      // The intake doesn't have it (never stored, or past its 90 days), and
      // won't: it's asked about again only when named.
      return last.state !== 'unknown' && nowMs - Date.parse(last.askedAt) >= ASK_EVERY_MS;
    });

    const answers = new Map<string, ReportStatus>();
    let failure: string | undefined;
    const toAskIds = toAsk.map((t) => t.reportId);
    for (const [i, chunk] of chunks(toAskIds).entries()) {
      const asked = await askStatus(origin, chunk, { fetch: ctx.fetch });
      if (asked.kind !== 'ok') {
        failure = intakeFailure(asked, 'asked', toAskIds.slice(i * MAX_REPORT_IDS));
        break;
      }
      for (const s of asked.value) answers.set(s.reportId, s);
    }
    const askedAt = new Date(nowMs).toISOString();
    if (answers.size > 0) {
      await updateStatuses(files, (records) => {
        for (const s of answers.values()) {
          const { reportId, ...rest } = s;
          records[reportId] = { ...rest, askedAt };
        }
      });
    }
    const fixes = targets.reports.flatMap((t) => {
      const s = answers.get(t.reportId);
      return s?.state === 'fixed' && t.entry !== undefined
        ? [{ entry: t.entry, note: `in ${s.fixedIn ?? 'a release'} (report ${t.reportId})` }]
        : [];
    });
    if (fixes.length > 0 && text !== undefined) {
      const path = join(packDir, FEEDBACK_FILENAME);
      await writeFile(path, markFixed(await readFile(path, 'utf8'), fixes), 'utf8');
    }

    const latest = await readStatuses(files);
    const reports = targets.reports.map((t) => {
      const answer = answers.get(t.reportId);
      const record = latest[t.reportId];
      const state: ReportState | 'not-asked' =
        answer?.state ?? record?.state ?? (t.withdrawn ? 'withdrawn' : 'not-asked');
      return {
        reportId: t.reportId,
        ...(t.entry !== undefined && { entry: t.entry }),
        state,
        ...pickDetails(answer ?? record),
        asked: answer !== undefined,
        ...(record?.askedAt !== undefined && {
          askedAt: answer !== undefined ? askedAt : record.askedAt,
        }),
      };
    });
    const value = { reports, ...(targets.notSent.length > 0 && { notSent: targets.notSent }) };
    if (failure !== undefined) {
      return result(ctx, value, `${failure} The answers on stdout are the last ones had.\n`, 1);
    }
    const notes = [
      targets.notSent.length > 0 ? `Not sent yet: ${targets.notSent.join(', ')}.` : '',
      fixes.length > 0
        ? `Marked fixed in ${FEEDBACK_FILENAME}: ${fixes.map((f) => f.entry).join(', ')}.`
        : '',
    ].filter((n) => n !== '');
    return result(ctx, value, notes.length > 0 ? `${notes.join('\n')}\n` : undefined);
  } catch (err) {
    return commandResultFromThrown(err, ctx, 'feedback status');
  }
}

export async function runWithdraw(ctx: CommandContext): Promise<CommandResult> {
  try {
    const named = ctx.positionals;
    if (named.length === 0) {
      throw new UsageError(
        'Name the reports to withdraw: kindgi feedback withdraw <id|hash|reportId>... (kindgi feedback status lists them).',
      );
    }
    const origin = accessOrigin(ctx);
    const packDir = packDirOf(ctx);
    const text = await readFeedback(packDir, 'optional');
    const targets = reportsOf(parseFeedback(text ?? ''), named, 'open');
    const files = feedbackFiles(homeOf(ctx));
    const keys = await readKeys(files);
    const sendable: { reportId: string; withdrawKey: string }[] = [];
    const noKey: string[] = [];
    for (const t of targets.reports) {
      const key = keys[t.reportId]?.withdrawKey;
      if (typeof key === 'string' && WITHDRAW_KEY.test(key))
        sendable.push({ reportId: t.reportId, withdrawKey: key });
      else noKey.push(t.reportId);
    }

    const withdrawn: string[] = [];
    const refused: string[] = [];
    let failure: string | undefined;
    for (const [i, chunk] of chunks(sendable).entries()) {
      const asked = await withdrawReports(origin, chunk, { fetch: ctx.fetch });
      if (asked.kind !== 'ok') {
        const left = sendable.slice(i * MAX_REPORT_IDS).map((r) => r.reportId);
        failure = intakeFailure(asked, 'withdrawn', left);
        break;
      }
      withdrawn.push(...asked.value.withdrawn);
      refused.push(...asked.value.refused);
    }
    if (withdrawn.length > 0) {
      const at = isoNow(ctx);
      await recordWithdrawn(files, withdrawn, at);
      if (text !== undefined) {
        const path = join(packDir, FEEDBACK_FILENAME);
        await writeFile(path, markWithdrawn(await readFile(path, 'utf8'), withdrawn, at), 'utf8');
      }
    }
    const value = {
      withdrawn,
      ...(refused.length > 0 && { refused }),
      ...(noKey.length > 0 && { noKey }),
      ...(targets.alreadyWithdrawn.length > 0 && { alreadyWithdrawn: targets.alreadyWithdrawn }),
      ...(targets.notSent.length > 0 && { notSent: targets.notSent }),
    };
    const notes = [
      failure,
      refused.length > 0
        ? `Refused: ${refused.join(', ')}. The intake doesn't know the report, it's past its 90 days, or the key isn't its.`
        : undefined,
      noKey.length > 0
        ? `No key on this machine for ${noKey.join(', ')}: the key stays on the machine that sent the report. Withdraw it from there.`
        : undefined,
      targets.notSent.length > 0
        ? `Not sent, so nothing to withdraw: ${targets.notSent.join(', ')}.`
        : undefined,
    ].filter((n): n is string => n !== undefined);
    const done =
      withdrawn.length > 0
        ? `✓ withdrew ${withdrawn.join(', ')}: the intake cleared their text.\n`
        : '';
    if (notes.length > 0) return result(ctx, value, `${done}${notes.join('\n')}\n`, 1);
    return result(ctx, value, done !== '' ? done : undefined);
  } catch (err) {
    return commandResultFromThrown(err, ctx, 'feedback withdraw');
  }
}

/**
 * The JSON on stdout and a note on stderr. A note is left out with
 * `--quiet`, unless the command failed.
 */
function result(
  ctx: CommandContext,
  value: unknown,
  note: string | undefined,
  exitCode = 0,
): CommandResult {
  const rendered = renderJson(value, ctx.globals.format);
  const quiet = ctx.globals.format === 'quiet' && exitCode === 0;
  return {
    kind: 'ok',
    rendered: { ...rendered, stderr: note === undefined || quiet ? '' : note },
    ...(exitCode !== 0 && { exitCode }),
  };
}

/** A report a command acts on, and the entry it came from when `FEEDBACK.md` has it. */
interface Target {
  readonly reportId: string;
  readonly entry?: string;
  readonly withdrawn: boolean;
}

/**
 * The reports named (an entry's id or hash, or a reportId), or with none
 * named, every report in `FEEDBACK.md`. `open` leaves out the withdrawn ones,
 * listed apart.
 */
function reportsOf(
  entries: readonly FeedbackEntry[],
  named: readonly string[],
  which: 'all' | 'open',
): {
  readonly reports: readonly Target[];
  readonly notSent: readonly string[];
  readonly alreadyWithdrawn: readonly string[];
} {
  const reports: Target[] = [];
  const notSent: string[] = [];
  const alreadyWithdrawn: string[] = [];
  const seen = new Set<string>();
  const add = (t: Target) => {
    if (seen.has(t.reportId)) return;
    seen.add(t.reportId);
    if (which === 'open' && t.withdrawn) alreadyWithdrawn.push(t.reportId);
    else reports.push(t);
  };
  const ofEntry = (e: FeedbackEntry) => {
    if (e.submissions.length === 0) notSent.push(e.fields.id ?? e.title);
    for (const s of e.submissions) {
      add({
        reportId: s.reportId,
        ...(e.fields.id !== undefined && { entry: e.fields.id }),
        withdrawn: s.withdrawnAt !== undefined,
      });
    }
  };
  if (named.length === 0) {
    for (const e of entries) if (e.submissions.length > 0) ofEntry(e);
    return { reports, notSent, alreadyWithdrawn };
  }
  const unmatched: string[] = [];
  for (const name of named) {
    const matching = entries.filter((e) => e.fields.id === name || e.fields.hash === name);
    if (matching.length > 0) {
      for (const e of matching) ofEntry(e);
      continue;
    }
    if (!REPORT_ID.test(name)) {
      unmatched.push(name);
      continue;
    }
    const from = entries.find((e) => e.submissions.some((s) => s.reportId === name));
    const sub = from?.submissions.find((s) => s.reportId === name);
    add({
      reportId: name,
      ...(from?.fields.id !== undefined && { entry: from.fields.id }),
      withdrawn: sub?.withdrawnAt !== undefined,
    });
  }
  if (unmatched.length > 0) {
    throw new UsageError(
      `${unmatched.join(', ')} ${unmatched.length === 1 ? "isn't" : "aren't"} an entry id or hash in ${FEEDBACK_FILENAME}, or a report id (fbr_…).`,
    );
  }
  return { reports, notSent, alreadyWithdrawn };
}

/** A withdrawn report's key is deleted, and its state is final. */
async function recordWithdrawn(
  files: FeedbackFiles,
  reportIds: readonly string[],
  at: string,
): Promise<void> {
  await updateKeys(files, (keys) => {
    for (const id of reportIds) delete keys[id];
  });
  await updateStatuses(files, (statuses) => {
    for (const id of reportIds) statuses[id] = { state: 'withdrawn', askedAt: at };
  });
}

function pickDetails(
  s: Omit<ReportStatus, 'reportId'> | undefined,
): Partial<Pick<ReportStatus, 'issueUrl' | 'fixedIn' | 'reason'>> {
  if (s === undefined) return {};
  return {
    ...(s.issueUrl !== undefined && { issueUrl: s.issueUrl }),
    ...(s.fixedIn !== undefined && { fixedIn: s.fixedIn }),
    ...(s.reason !== undefined && { reason: s.reason }),
  };
}

/** Why submit stopped, and whether Kindgi may have the reports all the same. */
function submitFailure(asked: Exclude<Asked<unknown>, { kind: 'ok' }>): string {
  if (asked.kind === 'failed' && asked.maybeReceived) {
    return `Kindgi may have received it: ${asked.message}. ${FEEDBACK_FILENAME} is unchanged, so sending it again makes a second report. One that arrived can't be withdrawn from this machine, since its key never came back; Kindgi deletes it after 90 days. What was sent is on stdout.`;
  }
  const why =
    asked.kind === 'failed'
      ? `Nothing reached Kindgi: ${asked.message}.`
      : asked.error === 'rate-limited'
        ? `Nothing was sent: the intake is taking no more reports for now${asked.retryAfter !== undefined ? `; try again in ${asked.retryAfter} s` : '; try again later'}.`
        : `The intake refused the report (${asked.status} ${asked.error}): ${asked.message} Nothing was stored.`;
  return `${why} ${FEEDBACK_FILENAME} is unchanged; what would have been sent is on stdout.`;
}

/** Why the intake answered none of `left` (the reports not yet answered), naming them. */
function intakeFailure(
  asked: Exclude<Asked<unknown>, { kind: 'ok' }>,
  what: 'asked' | 'withdrawn',
  left: readonly string[],
): string {
  const ids = left.join(', ');
  const rest = what === 'asked' ? `Not asked about: ${ids}.` : `Not withdrawn: ${ids}.`;
  if (asked.kind === 'failed' && asked.maybeReceived && what === 'withdrawn') {
    const which = left.length === 1 ? ids : `Some of ${ids}`;
    return `${asked.message}. ${which} may have been withdrawn: run it again to know (withdrawing twice is safe).`;
  }
  if (asked.kind === 'failed') return `${asked.message}. ${rest}`;
  if (asked.error === 'rate-limited') {
    return `The intake is busy${asked.retryAfter !== undefined ? `; try again in ${asked.retryAfter} s` : '; try again later'}. ${rest}`;
  }
  return `The intake refused (${asked.status} ${asked.error}): ${asked.message} ${rest}`;
}

/** `KINDGI_FEEDBACK_SUBMIT`: unset or `on` sends; `off` doesn't; anything else doesn't either, and says so. */
function submitOff(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '' || v === 'on') return undefined;
  if (v === 'off') {
    return `Sending feedback is off here (${SUBMIT_SWITCH}=off): nothing was sent. kindgi feedback write still records entries in ${FEEDBACK_FILENAME}, and status and withdraw still work.\n`;
  }
  return `Nothing was sent: ${SUBMIT_SWITCH} must be on or off (it's "${value}").\n`;
}

/** Two entries sharing an id can't go in one report: the answer is matched by it. */
function duplicateIds(entries: readonly FeedbackEntry[]): EntryProblem[] {
  const counts = new Map<string, number>();
  for (const e of entries)
    if (e.fields.id !== undefined) counts.set(e.fields.id, (counts.get(e.fields.id) ?? 0) + 1);
  return [...counts]
    .filter(([, n]) => n > 1)
    .map(([id, n]) => ({ entry: id, problem: `${n} entries have this id: give each its own` }));
}

async function readFeedback(packDir: string, need: 'required'): Promise<string>;
async function readFeedback(packDir: string, need: 'optional'): Promise<string | undefined>;
async function readFeedback(
  packDir: string,
  need: 'required' | 'optional',
): Promise<string | undefined> {
  try {
    return await readFile(join(packDir, FEEDBACK_FILENAME), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    if (need === 'optional') return undefined;
    throw new UsageError(
      `There's no ${FEEDBACK_FILENAME} in ${packDir}: write an entry first (kindgi feedback write).`,
    );
  }
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_REPORT_IDS)
    out.push(items.slice(i, i + MAX_REPORT_IDS));
  return out;
}

function packDirOf(ctx: CommandContext): string {
  const path = stringFlag(ctx, 'path');
  if (path === undefined) return ctx.cwd;
  return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

function homeOf(ctx: CommandContext): string {
  return pickHome({
    ...(ctx.home !== undefined ? { ctxHome: ctx.home } : {}),
    ...(typeof ctx.env.HOME === 'string' && ctx.env.HOME !== '' ? { envHome: ctx.env.HOME } : {}),
  });
}

function isoNow(ctx: CommandContext): string {
  return new Date((ctx.feedbackSeam?.now ?? Date.now)()).toISOString();
}

function thisPlatform(): Platform {
  return { os: platform(), osRelease: release(), arch: arch(), node: process.versions.node };
}

/** A person at a terminal: stdin and stderr are both TTYs. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

/** Ask a yes/no question on the terminal; only `y` or `yes` is a yes. */
async function confirmOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.question(question, resolveAnswer);
      rl.once('close', () => resolveAnswer(''));
    });
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}
