// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What `kindgi feedback submit` takes out of a report's text before the
 * person previews it, so the preview shows what would be sent. It cuts
 * down what the person has to catch. It can't promise free text is clean:
 * the preview is the guarantee. The rules run in this order:
 *
 *   1. **Private keys.** A `-----BEGIN … PRIVATE KEY-----` block, to its
 *      `END` line or the end of the text, becomes `[redacted]`.
 *   2. **The pack's env values.** Each value in the pack's env files
 *      (`readPackEnvEntries`) becomes `[redacted]` wherever it appears.
 *      That's a value of 8 characters or more, or of 4 or more under a key
 *      that looks secret (`isSecretKey`). A shorter one (`PORT=3000`) stays,
 *      so the text stays readable.
 *   3. **Tokens.** First, the shapes `@kindgi/log` masks in every log line
 *      (`scrubText`): a Kindgi token keeps its prefix and last four
 *      characters, `Bearer …` and a URL's password are masked. Then
 *      provider and cloud keys by their shape (`sk-…`, `AKIA…`, `ghp_…`,
 *      `xoxb-…`, `AIza…`, a JWT, …), and the value under a key that looks
 *      secret: `KEY=…`, `--api-key=…`, `"token": "…"`, and a whole
 *      `Authorization: …` line.
 *   4. **URLs.** A URL's user info, and each of its query values.
 *   5. **Emails** become `[email]`.
 *   6. **Paths.**
 *      - One inside the pack becomes relative to it (`./src/tool.ts`).
 *      - The home directory becomes `~`.
 *      - Any other absolute path becomes `[path]`: one under `~`, under a
 *        filesystem root such as `/Users`, `/home` or `/tmp`, after a drive
 *        letter, or on a UNC share. A path that doesn't start at one of
 *        those, like an API route (`/v1/secrets`), stays.
 *      - A path is cut at a space, and the preview shows what follows it.
 *
 * Nothing here reads a file or the environment: `redactForSending` takes
 * the pack's directory, the home directory and the env entries from its
 * caller, so the same text and context always give the same result (and
 * the digest the person OKs stays stable).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { REDACTED, isSecretKey, scrubText } from '@kindgi/log';

import { parseEnvFile } from '../env/parser.js';

/** What a redacted path, and a redacted email, read as. */
export const REDACTED_PATH = '[path]';
export const REDACTED_EMAIL = '[email]';

/** The rules, in the order they run. */
export const REDACTION_RULES = [
  'private-keys',
  'env-values',
  'tokens',
  'urls',
  'emails',
  'paths',
] as const;
export type RedactionRule = (typeof REDACTION_RULES)[number];

export interface EnvEntry {
  readonly key: string;
  readonly value: string;
}

export interface RedactionContext {
  /** The pack's directory, absolute. */
  readonly packDir: string;
  /** The home directory, absolute. */
  readonly home: string;
  /** Every entry in the pack's env files (`readPackEnvEntries`). */
  readonly envEntries: readonly EnvEntry[];
}

export interface Redacted {
  readonly text: string;
  /** The rules that changed something, in the order they ran. */
  readonly applied: readonly RedactionRule[];
}

/** Kindgi's own secrets file in a pack, which `kindgi secrets set` writes. */
const KINDGI_SECRETS_FILE = '.kindgi/secrets.env';

/**
 * Every entry in the pack's env files: each `.env*` file at its root, the
 * `dev.envFiles` given (relative to the pack), and Kindgi's own
 * `.kindgi/secrets.env`. It takes every file's entries, not just the ones
 * that win, since a value a later file overrides is still a secret. A
 * missing or unreadable file is skipped.
 */
export async function readPackEnvEntries(
  packDir: string,
  envFiles: readonly string[] = [],
): Promise<readonly EnvEntry[]> {
  const atRoot = await readdir(packDir, { withFileTypes: true }).catch(() => []);
  const files = new Set([
    ...atRoot.filter((e) => e.isFile() && e.name.startsWith('.env')).map((e) => e.name),
    ...envFiles,
    KINDGI_SECRETS_FILE,
  ]);
  const entries: EnvEntry[] = [];
  for (const file of [...files].sort()) {
    const raw = await readFile(join(packDir, file), 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    for (const line of parseEnvFile(raw)) {
      if (line.kind === 'entry' && line.key !== undefined && line.value !== undefined) {
        entries.push({ key: line.key, value: line.value });
      }
    }
  }
  return entries;
}

/** The text with every rule applied (see the header), and which rules changed it. */
export function redactForSending(text: string, ctx: RedactionContext): Redacted {
  const applied: RedactionRule[] = [];
  let out = text;
  const step = (rule: RedactionRule, apply: (s: string) => string): void => {
    const next = apply(out);
    if (next !== out) applied.push(rule);
    out = next;
  };
  step('private-keys', (s) => s.replace(PRIVATE_KEY_BLOCK, REDACTED));
  step('env-values', (s) => redactEnvValues(s, ctx.envEntries));
  step('tokens', redactTokens);
  step('urls', (s) => s.replace(URL_IN_TEXT, redactUrl));
  step('emails', (s) => s.replace(EMAIL, REDACTED_EMAIL));
  step('paths', (s) => redactPaths(s, ctx));
  return { text: out, applied };
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A value that already stands for something else: nothing to redact. */
const isPlaceholder = (value: string): boolean =>
  value === '' || value === REDACTED || /^(?:\$|<|\*\*\*)/.test(value);

function redactEnvValues(text: string, entries: readonly EnvEntry[]): string {
  const values = new Set<string>();
  for (const { key, value } of entries) {
    if (isPlaceholder(value)) continue;
    if (value.length >= 8 || (value.length >= 4 && isSecretKey(key))) values.add(value);
  }
  // The longest first, so a value that holds a shorter one goes whole.
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED);
  }
  return out;
}

/** Provider and cloud keys, by the shapes their issuers give them. */
const PROVIDER_KEYS: readonly RegExp[] = [
  // OpenAI, Anthropic, OpenRouter and others: `sk-`, `sk-proj-`, `sk-ant-`, `sk-or-v1-`.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // Slack tokens.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}/g,
  // Stripe keys.
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  // SendGrid keys.
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  // Hugging Face tokens.
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  // A JWT: three base64url parts, the first two JSON objects.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** `"key": "value"`, in JSON. */
const JSON_PAIR = /"([^"\\\n]{1,100})"(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g;
/** `KEY=value`, `--key=value`, `key = "value"`. */
const ASSIGNMENT =
  /(?<![\w.])([A-Za-z_][\w.-]*)(\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'`,;&]+))/g;
/** `Key: value` starting a line, as in YAML or an HTTP header: the rest of the line. */
const LINE_PAIR = /^([ \t]*)([A-Za-z_][\w.-]*)([ \t]*:[ \t]+)(\S.*)$/gm;
/** An Azure connection string's key. */
const AZURE_KEY = /\b(AccountKey|SharedAccessKey)=[^;\s"']+/g;

function redactTokens(text: string): string {
  let out = scrubText(text);
  for (const shape of PROVIDER_KEYS) out = out.replace(shape, REDACTED);
  out = out.replace(AZURE_KEY, `$1=${REDACTED}`);
  out = out.replace(JSON_PAIR, (m, key: string, colon: string, value: string) =>
    isSecretKey(key) && !isPlaceholder(value) ? `"${key}"${colon}"${REDACTED}"` : m,
  );
  out = out.replace(
    ASSIGNMENT,
    (
      m,
      key: string,
      eq: string,
      dq: string | undefined,
      sq: string | undefined,
      bare: string | undefined,
    ) => {
      const value = dq ?? sq ?? bare ?? '';
      if (!isSecretKey(key) || isPlaceholder(value)) return m;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
      return `${key}${eq}${quote}${REDACTED}${quote}`;
    },
  );
  out = out.replace(LINE_PAIR, (m, indent: string, key: string, colon: string, value: string) =>
    isSecretKey(key) && !isPlaceholder(value) ? `${indent}${key}${colon}${REDACTED}` : m,
  );
  return out;
}

const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s"'<>`]+)/gi;

/** A URL with its user info and each query value redacted. */
function redactUrl(_m: string, scheme: string, rest: string): string {
  const at = rest.search(/[/?#]/);
  const authority = at === -1 ? rest : rest.slice(0, at);
  let tail = at === -1 ? '' : rest.slice(at);
  const userinfo = authority.lastIndexOf('@');
  const host = userinfo === -1 ? authority : `${REDACTED}@${authority.slice(userinfo + 1)}`;
  const q = tail.indexOf('?');
  if (q !== -1) {
    const hash = tail.indexOf('#', q);
    const query = tail.slice(q + 1, hash === -1 ? undefined : hash);
    const redacted = query
      .split('&')
      .map((pair) => {
        if (pair === '') return pair;
        const eq = pair.indexOf('=');
        return eq === -1 ? REDACTED : `${pair.slice(0, eq)}=${REDACTED}`;
      })
      .join('&');
    tail = `${tail.slice(0, q + 1)}${redacted}${hash === -1 ? '' : tail.slice(hash)}`;
  }
  return `${scheme}${host}${tail}`;
}

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** The characters a path runs through: it stops at a space, a quote, a bracket or a colon. */
const PATH_CHARS = '[^\\s"\'`<>|:;,()\\[\\]{}]*';
/** A separator: `/`, `\`, or `\\` (a backslash in JSON). */
const SEP = '(\\\\\\\\|[\\\\/])';

/** The roots an absolute POSIX path starts at, as far as a report goes. */
const POSIX_ROOTS = [
  'Users',
  'home',
  'root',
  'private',
  'tmp',
  'var',
  'opt',
  'etc',
  'mnt',
  'media',
  'Volumes',
  'srv',
  'usr',
  'nix',
  'workspace',
  'workspaces',
  'data',
  'app',
  'run',
  'snap',
  'Library',
  'Applications',
  'System',
];

const TILDE_PATH = new RegExp(`(?<![\\w.-])~${SEP}${PATH_CHARS}`, 'g');
const POSIX_PATH = new RegExp(
  `(?<![\\w.~-])/(?:${POSIX_ROOTS.join('|')})(?![\\w.-])(?:/${PATH_CHARS})?`,
  'g',
);
const DRIVE_PATH = new RegExp(`(?<![\\w])[A-Za-z]:${SEP}${PATH_CHARS}`, 'g');
const UNC_PATH = new RegExp(`(?<![\\w\\\\])\\\\\\\\[\\w.$-]+\\\\${PATH_CHARS}`, 'g');

const isWindowsPath = (dir: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(dir);

/** The ways a directory can be written in text: as given, with either separator, and JSON-escaped. */
function spellings(dir: string): string[] {
  const trimmed = dir.replace(/[\\/]+$/, '');
  if (trimmed === '') return [];
  if (!isWindowsPath(trimmed)) return [trimmed];
  const back = trimmed.replace(/\//g, '\\');
  return [...new Set([back, back.replace(/\\/g, '/'), back.replace(/\\/g, '\\\\')])];
}

/** `dir` replaced by `to`, at path boundaries: `to` alone for the directory, `to<sep>` before a path in it. */
function replaceDir(text: string, dir: string, to: string): string {
  let out = text;
  // The longest spelling first: the JSON-escaped one holds the others' prefixes.
  for (const spelling of spellings(dir).sort((a, b) => b.length - a.length)) {
    const flags = isWindowsPath(spelling) ? 'gi' : 'g';
    const re = new RegExp(`(?<![\\w.-])${escapeRegExp(spelling)}(?:${SEP}|(?![\\w.-]))`, flags);
    out = out.replace(re, (_m, sep: string | undefined) =>
      sep === undefined ? to : `${to}${sep}`,
    );
  }
  return out;
}

function redactPaths(text: string, ctx: RedactionContext): string {
  let out = replaceDir(text, ctx.packDir, '.');
  out = replaceDir(out, ctx.home, '~');
  return out
    .replace(TILDE_PATH, REDACTED_PATH)
    .replace(UNC_PATH, REDACTED_PATH)
    .replace(DRIVE_PATH, REDACTED_PATH)
    .replace(POSIX_PATH, REDACTED_PATH);
}
