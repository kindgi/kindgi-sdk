// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { KindgiApiError, type KindgiError } from '@kindgi/client';

import { unwiredReason } from './commands/unwired.js';

/**
 * The CLI-level exit envelope. Every command handler returns one so the
 * top-level dispatcher can pick exit codes and write stdout/stderr
 * exactly once.
 */
export interface CliError {
  readonly kind: 'error';
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout?: string;
}

export function cliError(message: string, exitCode = 1): CliError {
  return { kind: 'error', exitCode, stderr: `${message}\n` };
}

/**
 * Format any thrown value into an error envelope suitable for CLI
 * output. Recognises the SDK's `KindgiApiError` (typed wire error),
 * plus the preview stub (`not-implemented-in-preview`), and falls back
 * to raw `Error.message` for anything else.
 */
export function formatThrown(
  thrown: unknown,
  options: { readonly verbose?: boolean; readonly commandLabel: string },
): CliError {
  const wire = extractKindgiError(thrown);
  if (wire !== null) {
    if (wire.code === 'not-implemented-in-preview') {
      const label = options.commandLabel.startsWith('kindgi ')
        ? options.commandLabel
        : `kindgi ${options.commandLabel}`;
      const reason = unwiredReason(label.slice('kindgi '.length).split(' '));
      return cliError(
        reason !== undefined
          ? `Command '${label}' is not available: ${reason}`
          : `Command '${label}' is not yet wired — SDK method '${wire.method}' is not available in this preview release.`,
        2,
      );
    }
    // Validation failures (AJV rejects on tool input, schema-validation-failed
    // on body input) are useless without the `issues` array — the whole
    // point of the error is "which field failed how". Promote those from
    // --verbose-only to always-shown; every other error stays terse
    // unless --verbose asks otherwise.
    const detail = options.verbose
      ? `\n${JSON.stringify(wire, null, 2)}`
      : formatValidationDetail(wire);
    return cliError(`Error [${errorTag(wire)}]: ${wire.message}${detail}`, 1);
  }
  if (thrown instanceof Error) {
    const detail = options.verbose && thrown.stack ? `\n${thrown.stack}` : '';
    return cliError(`Error: ${thrown.message}${detail}`, 1);
  }
  return cliError(`Error: ${String(thrown)}`, 1);
}

/**
 * The code an error line shows: a conflict's own reason when it has one
 * (`registry-read-only`, `agent-already-registered`), which says more
 * than `conflict`; the server's own code for a server-class error that
 * carries one (`gate-failed`, `budget-exceeded`, `secret-store-error`),
 * which says more than `server`; otherwise the error's code.
 */
function errorTag(wire: KindgiError): string {
  const reason = (wire as { readonly reason?: unknown }).reason;
  if (wire.code === 'conflict' && typeof reason === 'string' && reason !== '') return reason;
  // `unknown` is the client's own stand-in for a body without a code.
  if (wire.code === 'server' && wire.serverCode !== '' && wire.serverCode !== 'unknown') {
    return wire.serverCode;
  }
  return wire.code;
}

/**
 * Format validation-issue detail inline (no --verbose required). We
 * treat two error shapes as "validation":
 *
 *   - `code === 'server' && serverCode === 'tool-invocation-failed'`
 *     with `fields.validationIssues` — AJV rejected the LLM's tool
 *     arguments. Also emit the `receivedInput` truncated payload so
 *     the author sees what the model actually sent.
 *   - `code === 'invalid-request'` with `issues[]` — server-side
 *     body validation. Emit each JSON-pointer + reason.
 *
 * Everything else returns `''` and stays on the terse one-liner.
 */
function formatValidationDetail(wire: KindgiError): string {
  if (wire.code === 'server' && wire.serverCode === 'tool-invocation-failed') {
    const fields = wire.fields;
    if (fields === undefined) return '';
    const issues = fields.validationIssues;
    if (!Array.isArray(issues) || issues.length === 0) return '';
    const lines: string[] = [''];
    for (const issue of issues as readonly Readonly<Record<string, unknown>>[]) {
      const path =
        typeof issue.instancePath === 'string' && issue.instancePath !== ''
          ? issue.instancePath
          : typeof issue.path === 'string'
            ? issue.path
            : '<root>';
      const reason =
        typeof issue.message === 'string'
          ? issue.message
          : typeof issue.keyword === 'string'
            ? issue.keyword
            : JSON.stringify(issue);
      lines.push(`  ✗ ${path}: ${reason}`);
    }
    if (fields.receivedInput !== undefined) {
      lines.push(`  received: ${JSON.stringify(fields.receivedInput)}`);
    }
    return lines.join('\n');
  }
  if (wire.code === 'invalid-request' && wire.issues.length > 0) {
    const lines: string[] = [''];
    for (const issue of wire.issues) {
      const path = issue.path === '' ? '<root>' : issue.path;
      lines.push(`  ✗ ${path}: ${issue.message}`);
    }
    return lines.join('\n');
  }
  return '';
}

/**
 * The SDK's `notImplementedInPreview()` currently returns a plain POJO
 * (`{ code, message, method }`) that is `throw`n as-is — not wrapped
 * in `KindgiApiError`. Recognise both shapes so callers see uniform
 * error output.
 */
export function extractKindgiError(thrown: unknown): KindgiError | null {
  if (thrown instanceof KindgiApiError) return thrown.error;
  if (
    thrown !== null &&
    typeof thrown === 'object' &&
    'code' in thrown &&
    typeof (thrown as { code: unknown }).code === 'string' &&
    'message' in thrown &&
    typeof (thrown as { message: unknown }).message === 'string'
  ) {
    return thrown as KindgiError;
  }
  return null;
}
