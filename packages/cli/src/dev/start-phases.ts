// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What `kindgi dev` says while the Kindgi runtime starts: each phase as it
 * happens, and how long it took. Pulling the image (its size, and how much
 * has come as each layer arrives), starting the container, migrating the
 * database (from the runtime's own `migrations` records; an image that
 * writes none shows no such phase, and that time counts as waiting), then
 * waiting for it to serve. A phase that takes a while gets a line every few
 * seconds, so a long pull or migration never looks stuck.
 */

export type StartPhase = 'pull' | 'container' | 'migrate' | 'serve';

export interface StartPhases {
  /** A phase begins. One still open ends without a line (waiting gives way to migrating). */
  begin(phase: StartPhase, note?: string): void;
  /** What the open phase has done so far (a pull's bytes), shown on its next line. */
  progress(note: string): void;
  /** The open phase ends: a line saying so, with how long it took. */
  end(note?: string): void;
  /** No more lines: the start served, failed or was stopped. */
  close(): void;
  /** How long since the first phase began. */
  elapsedMs(): number;
}

const LABELS: Readonly<Record<StartPhase, { readonly doing: string; readonly done: string }>> = {
  pull: { doing: 'pulling the runtime image', done: 'pulled the runtime image' },
  container: { doing: 'starting its container', done: 'started its container' },
  migrate: { doing: 'migrating the database', done: 'migrated the database' },
  serve: { doing: 'waiting for it to serve', done: 'serving' },
};

/** How often a phase that's still going says so. */
export const PHASE_HEARTBEAT_MS = 3000;

/** Phase lines sit under "Starting the Kindgi runtime...". */
const INDENT = '  ';

export function createStartPhases(options: {
  readonly emit: (line: string) => void;
  readonly heartbeatMs?: number;
}): StartPhases {
  const heartbeatMs = options.heartbeatMs ?? PHASE_HEARTBEAT_MS;
  let open: { phase: StartPhase; startedAt: number; note: string | undefined } | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let firstAt: number | undefined;
  let closed = false;

  const stopTicking = (): void => {
    if (tick !== undefined) clearInterval(tick);
    tick = undefined;
  };
  // Each phase's own clock: its lines come at 3s, 6s, … into it.
  const startTicking = (): void => {
    stopTicking();
    tick = setInterval(() => {
      if (open === undefined) return;
      const seconds = Math.round((Date.now() - open.startedAt) / 1000);
      const note = open.note === undefined ? '' : `: ${open.note}`;
      options.emit(`${INDENT}⋯ ${LABELS[open.phase].doing}${note} (${seconds}s)`);
    }, heartbeatMs);
    // The heartbeat never keeps the CLI alive by itself.
    tick.unref?.();
  };

  return {
    begin(phase, note) {
      if (closed) return;
      const now = Date.now();
      firstAt ??= now;
      open = { phase, startedAt: now, note };
      startTicking();
      // A pull says what's coming at once: its size is news.
      if (phase === 'pull') {
        options.emit(`${INDENT}⋯ ${LABELS.pull.doing}${note === undefined ? '' : `: ${note}`}`);
        open.note = undefined;
      }
    },
    progress(note) {
      if (open !== undefined) open.note = note;
    },
    end(note) {
      if (closed || open === undefined) return;
      stopTicking();
      const took = formatDuration(Date.now() - open.startedAt);
      const what = note === undefined ? '' : `: ${note}`;
      options.emit(`${INDENT}✓ ${LABELS[open.phase].done}${what} in ${took}`);
      open = undefined;
    },
    close() {
      closed = true;
      open = undefined;
      stopTicking();
    },
    elapsedMs() {
      return firstAt === undefined ? 0 : Date.now() - firstAt;
    },
  };
}

/** A duration as people say it: `0.4s`, `12s`, `1m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** A size as docker states one (decimal units): `812 kB`, `48.2 MB`, `412 MB`, `1.24 GB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} kB`;
  const mb = bytes / 1_000_000;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(2)} GB`;
}

/** No phases: what a start reports when no one listens (a test's fake runtime). */
export const NO_START_PHASES: StartPhases = {
  begin: () => undefined,
  progress: () => undefined,
  end: () => undefined,
  close: () => undefined,
  elapsedMs: () => 0,
};
