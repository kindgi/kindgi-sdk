// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Writer side: render entries so they READ BACK as the exact value
 * written — through `dotenv`'s parser and `expand.ts`'s `${VAR}`
 * expansion (the pipeline Next.js / Vite / dotenv-cli apply) — and keep
 * every untouched line byte-for-byte.
 *
 * Round-trip contract, for any string `v` the writer accepts:
 *
 *     expandEnv(envLinesToRecord(parseEnvFile(setKey('', K, v).contents))).values[K] === v
 *
 * Quoting, first rule that fits wins:
 *   1. Plain value (`[A-Za-z0-9_.,:/@+=%~-]+`) → unquoted.
 *   2. Double quotes, when the value has no `"` and no literal `\n` /
 *      `\r` sequence (dotenv would turn those into control chars).
 *      Real newlines / carriage returns are written as `\n` / `\r`.
 *   3. Single quotes (literal), when the value has no `'` and no `\r`.
 *   4. Backticks (literal), when the value has no `` ` `` and no `\r`.
 *   Otherwise the value is not representable in dotenv syntax and
 *   `EnvValueNotRepresentableError` is thrown — never a silently
 *   different value.
 *
 * `$` is always written as `\$`: expanders substitute `$NAME` even
 * inside quotes, and `\$` is the one escape they all undo.
 */

import { ENV_KEY_REGEX, type EnvLine, parseEntryRaw, parseEnvFile } from './parse.js';

/** Thrown when a value cannot be written so that it reads back unchanged. */
export class EnvValueNotRepresentableError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(
      `The value for ${key} cannot be written to a dotenv file so that it reads back unchanged (it mixes quote characters with content no dotenv quoting style can hold).`,
    );
    this.name = 'EnvValueNotRepresentableError';
    this.key = key;
  }
}

const PLAIN = /^[A-Za-z0-9_.,:/@+=%~-]+$/;

/** Render one `KEY=value` entry (throws `EnvValueNotRepresentableError`). */
export function renderEntry(
  key: string,
  value: string,
  options: { exported?: boolean } = {},
): string {
  const prefix = options.exported === true ? 'export ' : '';
  return `${prefix}${key}=${renderValue(key, value)}`;
}

function renderValue(key: string, value: string): string {
  if (value === '') return '""';
  const escaped = value.replace(/\$/g, '\\$');
  if (PLAIN.test(escaped)) return escaped;
  if (!escaped.includes('"') && !/\\[nr]/.test(escaped)) {
    return `"${escaped.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  }
  if (!value.includes('\r')) {
    if (!escaped.includes("'")) return `'${escaped}'`;
    if (!escaped.includes('`')) return `\`${escaped}\``;
  }
  throw new EnvValueNotRepresentableError(key);
}

/**
 * Serialize lines back to file text with a trailing newline. An entry
 * whose `raw` still parses to its `key` / `value` is emitted verbatim
 * (hand-written quoting, `export`, inline comments survive); any other
 * entry is re-rendered from `key` / `value`. Non-entry lines are
 * emitted verbatim — a malformed line is never dropped.
 */
export function serializeEnvFile(lines: readonly EnvLine[]): string {
  const body = lines.map(serializeLine).join('\n');
  return body === '' ? '' : `${body}\n`;
}

function serializeLine(line: EnvLine): string {
  if (line.kind !== 'entry' || line.key === undefined || line.value === undefined) return line.raw;
  const reparsed = parseEntryRaw(line.raw);
  if (
    reparsed !== undefined &&
    reparsed.key === line.key &&
    reparsed.value === line.value &&
    (reparsed.exported === true) === (line.exported === true)
  ) {
    return line.raw;
  }
  return renderEntry(line.key, line.value, { exported: line.exported === true });
}

/**
 * Set `KEY=value`. When the key already exists, the LAST occurrence —
 * the one readers see — is replaced in place (keeping its `export`
 * prefix); otherwise the entry is appended. `key` must be a POSIX env
 * name (`ENV_KEY_REGEX`).
 */
export function setKey(
  rawFileContents: string,
  key: string,
  value: string,
): { readonly contents: string; readonly overwritten: boolean } {
  if (!ENV_KEY_REGEX.test(key)) {
    throw new TypeError(`Invalid env key "${key}" — must match ${ENV_KEY_REGEX.source}.`);
  }
  const lines = [...parseEnvFile(rawFileContents)];
  let target = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line?.kind === 'entry' && line.key === key) {
      target = i;
      break;
    }
  }
  const exported = target === -1 ? false : lines[target]?.exported === true;
  const raw = renderEntry(key, value, { exported });
  const replacement: EnvLine = exported
    ? { kind: 'entry', raw, key, value, exported: true }
    : { kind: 'entry', raw, key, value };
  if (target === -1) lines.push(replacement);
  else lines[target] = replacement;
  return { contents: serializeEnvFile(lines), overwritten: target !== -1 };
}

/**
 * Remove every entry for KEY; unrelated lines are preserved.
 * Idempotent — `removed: false` when the key wasn't present.
 */
export function unsetKey(
  rawFileContents: string,
  key: string,
): { readonly contents: string; readonly removed: boolean } {
  const lines = parseEnvFile(rawFileContents);
  let removed = false;
  const kept: EnvLine[] = [];
  for (const line of lines) {
    if (line.kind === 'entry' && line.key === key) {
      removed = true;
      continue;
    }
    kept.push(line);
  }
  return { contents: serializeEnvFile(kept), removed };
}
