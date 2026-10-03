// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Output shapes used by every command handler. The dispatcher picks a
 * formatter based on the caller's `--json` / `--table` / `--raw` /
 * `--quiet` flags.
 */

export type OutputFormat = 'json' | 'table' | 'raw' | 'quiet';

export interface Column<T> {
  readonly header: string;
  readonly get: (row: T) => string;
}

export interface Rendered {
  readonly stdout: string;
  readonly stderr: string;
}

export function renderJson(value: unknown, format: OutputFormat): Rendered {
  if (format === 'quiet') return { stdout: '', stderr: '' };
  if (format === 'raw') return { stdout: `${JSON.stringify(value)}\n`, stderr: '' };
  return { stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: '' };
}

export function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[]): Rendered {
  if (rows.length === 0) return { stdout: '(no rows)\n', stderr: '' };
  const headers = columns.map((c) => c.header);
  const cells = rows.map((row) => columns.map((c) => c.get(row)));
  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const row of cells) {
      const v = row[i] ?? '';
      if (v.length > w) w = v.length;
    }
    return w;
  });
  const line = (values: readonly string[]): string =>
    values
      .map((v, i) => v.padEnd(widths[i] ?? 0, ' '))
      .join('  ')
      .trimEnd();
  const sep = widths
    .map((w) => '─'.repeat(w))
    .join('  ')
    .trimEnd();
  const body = cells.map(line).join('\n');
  return { stdout: `${line(headers)}\n${sep}\n${body}\n`, stderr: '' };
}

/**
 * Render a value, choosing between JSON and table representations based on
 * the requested format. If `--table` is requested but no columns are given
 * (e.g. a get-by-id result), fall back to pretty JSON.
 */
export function renderResult<T>(
  value: T,
  format: OutputFormat,
  options: {
    readonly rows?: readonly unknown[];
    readonly columns?: readonly Column<unknown>[];
  } = {},
): Rendered {
  if (format === 'table' && options.rows && options.columns) {
    return renderTable(options.rows, options.columns);
  }
  return renderJson(value, format);
}
