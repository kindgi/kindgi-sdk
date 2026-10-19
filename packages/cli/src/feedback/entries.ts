// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `FEEDBACK.md`'s entries, read back: what `kindgi feedback write` appended,
 * plus what a person or an agent edited since. An entry is a `## <title>`
 * heading followed by its metadata list (`- **id:** …`, `- **hash:** …`,
 * …); a `## ` heading without one is part of the entry above it, so a body
 * can have headings of its own. Fenced code blocks are skipped.
 *
 * `submit`, `status` and `withdraw` edit the file through here, one line at
 * a time, and leave every other byte as it was:
 * - `- **submitted:** <date> · **report:** <reportId>` after the metadata,
 *   one per submission;
 * - ` · **withdrawn:** <date>` at the end of that line;
 * - `> **Fixed:** <note>` under the heading, as a person marks it by hand.
 */

export type FeedbackKind = 'bug' | 'friction' | 'question' | 'design';
export type FeedbackSeverity = 'blocker' | 'high' | 'medium' | 'low';

export const KINDS: readonly FeedbackKind[] = ['bug', 'friction', 'question', 'design'];
export const SEVERITIES: readonly FeedbackSeverity[] = ['blocker', 'high', 'medium', 'low'];
export const AUTHORS = ['claude-code', 'human', 'mixed'] as const;

export const FEEDBACK_FILENAME = 'FEEDBACK.md';

/** One submission of an entry, from its `submitted` line. */
export interface Submission {
  readonly reportId: string;
  readonly submittedAt: string;
  readonly withdrawnAt?: string;
}

export interface FeedbackEntry {
  readonly title: string;
  /** The metadata as written (`id`, `hash`, `kind`, …), each value trimmed. */
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
  /** A `> **Fixed:** …` line under the heading. */
  readonly fixed: boolean;
  readonly submissions: readonly Submission[];
}

interface Located {
  readonly entry: FeedbackEntry;
  readonly heading: number;
  /** The last metadata line: where a new `submitted` line goes after. */
  readonly lastMeta: number;
  /** Each submission's line, by reportId. */
  readonly submissionLines: ReadonlyMap<string, number>;
}

const HEADING = /^## (?!#)(.*)$/;
const META = /^- \*\*[a-z][a-z-]*:\*\*/;
const SEGMENT = /^\*\*([a-z][a-z-]*):\*\*\s*(.*)$/;
const FIXED = /^>\s*\*\*Fixed:\*\*/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Every entry in the file, in order. */
export function parseFeedback(text: string): FeedbackEntry[] {
  return locate(splitLines(text).lines).map((l) => l.entry);
}

/** Add one `submitted` line per report, after its entry's metadata. */
export function addSubmissions(
  text: string,
  reports: readonly { readonly entry: string; readonly reportId: string }[],
  submittedAt: string,
): { readonly text: string; readonly missing: readonly string[] } {
  const { lines, eol, trailing } = splitLines(text);
  const missing: string[] = [];
  const located = locate(lines);
  // Each entry's new lines, in the order the reports came in.
  const byLine = new Map<number, string[]>();
  for (const report of reports) {
    const at = located.find((l) => l.entry.fields.id === report.entry);
    if (at === undefined) {
      missing.push(report.entry);
      continue;
    }
    const added = byLine.get(at.lastMeta) ?? [];
    added.push(`- **submitted:** ${submittedAt} · **report:** ${report.reportId}`);
    byLine.set(at.lastMeta, added);
  }
  const out = [...lines];
  // Bottom up, so an insertion never moves a line still to be edited.
  for (const [after, added] of [...byLine].sort((a, b) => b[0] - a[0])) {
    out.splice(after + 1, 0, ...added);
  }
  return { text: joinLines(out, eol, trailing), missing };
}

/** End each report's `submitted` line with ` · **withdrawn:** <date>`, once. */
export function markWithdrawn(
  text: string,
  reportIds: readonly string[],
  withdrawnAt: string,
): string {
  const { lines, eol, trailing } = splitLines(text);
  const out = [...lines];
  for (const at of locate(lines)) {
    for (const reportId of reportIds) {
      const line = at.submissionLines.get(reportId);
      const sub = at.entry.submissions.find((s) => s.reportId === reportId);
      if (line === undefined || sub === undefined || sub.withdrawnAt !== undefined) continue;
      out[line] = `${(out[line] as string).replace(/\s+$/, '')} · **withdrawn:** ${withdrawnAt}`;
    }
  }
  return joinLines(out, eol, trailing);
}

/** Put `> **Fixed:** <note>` under the heading of each entry not marked fixed yet. */
export function markFixed(
  text: string,
  fixes: readonly { readonly entry: string; readonly note: string }[],
): string {
  const { lines, eol, trailing } = splitLines(text);
  const out = [...lines];
  const located = locate(lines);
  // One note per entry (the first given), bottom up.
  const notes = new Map<number, string>();
  for (const fix of fixes) {
    const at = located.find((l) => l.entry.fields.id === fix.entry);
    if (at !== undefined && !at.entry.fixed && !notes.has(at.heading)) {
      notes.set(at.heading, fix.note);
    }
  }
  for (const [heading, note] of [...notes].sort((a, b) => b[0] - a[0])) {
    const spaced = (out[heading + 1] ?? '').trim() === '';
    out.splice(heading + 1, 0, '', `> **Fixed:** ${note}`, ...(spaced ? [] : ['']));
  }
  return joinLines(out, eol, trailing);
}

function locate(lines: readonly string[]): Located[] {
  const headings: number[] = [];
  let fence: string | undefined;
  for (const [i, line] of lines.entries()) {
    const f = FENCE.exec(line);
    if (f !== null) {
      const mark = (f[1] as string)[0] as string;
      if (fence === undefined) fence = mark;
      else if (fence === mark) fence = undefined;
      continue;
    }
    if (fence === undefined && HEADING.test(line) && startsEntry(lines, i)) headings.push(i);
  }
  return headings.map((heading, n) => readEntry(lines, heading, headings[n + 1] ?? lines.length));
}

/** A heading starts an entry when its metadata list follows it (blank and `>` lines between). */
function startsEntry(lines: readonly string[], heading: number): boolean {
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '' || line.startsWith('>')) continue;
    return /^- \*\*id:\*\*/.test(line);
  }
  return false;
}

function readEntry(lines: readonly string[], heading: number, end: number): Located {
  const title = (HEADING.exec(lines[heading] as string)?.[1] ?? '').trim();
  let i = heading + 1;
  let fixed = false;
  for (; i < end; i++) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    if (line.startsWith('>')) {
      if (FIXED.test(line)) fixed = true;
      continue;
    }
    break;
  }
  const fields: Record<string, string> = {};
  const submissions: Submission[] = [];
  const submissionLines = new Map<string, number>();
  let lastMeta = i;
  for (; i < end && META.test(lines[i] as string); i++) {
    lastMeta = i;
    const segments = readSegments(lines[i] as string);
    const reportId = segments.report;
    if (segments.submitted !== undefined && reportId !== undefined) {
      submissions.push({
        reportId,
        submittedAt: segments.submitted,
        ...(segments.withdrawn !== undefined && { withdrawnAt: segments.withdrawn }),
      });
      submissionLines.set(reportId, i);
      continue;
    }
    for (const [key, value] of Object.entries(segments)) fields[key] ??= value;
  }
  let last = end - 1;
  while (last >= i && (lines[last] as string).trim() === '') last--;
  if (last >= i && (lines[last] as string).trim() === '---') last--;
  const body = lines
    .slice(i, last + 1)
    .join('\n')
    .trim();
  return {
    entry: { title, fields, body, fixed, submissions },
    heading,
    lastMeta,
    submissionLines,
  };
}

/** `- **sdk:** 0.1.8 · **cli:** 0.1.8 · **by:** human` as `{ sdk, cli, by }`. */
function readSegments(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.slice(2).split(' · ')) {
    const m = SEGMENT.exec(part.trim());
    if (m !== null) out[m[1] as string] ??= (m[2] as string).trim();
  }
  return out;
}

/** The lines without their `\r`, and how to put them back. */
function splitLines(text: string): {
  readonly lines: string[];
  readonly eol: string;
  readonly trailing: boolean;
} {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.endsWith('\n');
  const body = trailing ? text.replace(/\r?\n$/, '') : text;
  return { lines: body === '' ? [] : body.split(/\r?\n/), eol, trailing };
}

function joinLines(lines: readonly string[], eol: string, trailing: boolean): string {
  return lines.join(eol) + (trailing ? eol : '');
}
