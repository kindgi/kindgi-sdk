// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The code an error line shows: the most specific one the error carries. */

import { describe, expect, test } from 'vitest';

import { KindgiApiError, fromWire } from '@kindgi/client';

import { UsageError, formatThrown } from '../src/errors.js';

const line = (body: Record<string, unknown>, status: number) =>
  formatThrown(new KindgiApiError(fromWire(body, status)), {
    commandLabel: 'kindgi runs start',
  }).stderr.trimEnd();

describe('error tags', () => {
  test.each([
    [{ code: 'gate-failed', message: 'The gate refused the promotion' }, 422, 'gate-failed'],
    [
      { code: 'budget-exceeded', message: 'Agent turn cost budget exceeded' },
      422,
      'budget-exceeded',
    ],
    [
      { code: 'agent-version-mismatch', message: 'Opened with 0.1.0' },
      409,
      'agent-version-mismatch',
    ],
    [
      { code: 'secret-store-error', message: 'Dev secrets live in your env files' },
      500,
      'secret-store-error',
    ],
  ])('a server-class error shows its own code: %j (%i)', (body, status, tag) => {
    expect(line(body, status)).toBe(`Error [${tag}]: ${body.message}`);
  });

  test('a body with no code keeps `server`', () => {
    expect(line({}, 500)).toMatch(/^Error \[server\]: /);
  });

  test("a conflict shows its reason; a typed family keeps the family's code", () => {
    expect(line({ code: 'registry-read-only', message: 'read-only' }, 409)).toBe(
      'Error [registry-read-only]: read-only',
    );
    expect(line({ code: 'agent-not-found', message: 'none' }, 404)).toBe('Error [not-found]: none');
  });
});

describe('formatThrown: a usage error (T348)', () => {
  test('exits 2, with its message and where the usage is', () => {
    expect(
      formatThrown(new UsageError('Missing required argument: run-id'), {
        commandLabel: 'runs get',
      }),
    ).toEqual({
      kind: 'error',
      exitCode: 2,
      stderr: 'Error: Missing required argument: run-id\nUsage: kindgi runs get --help\n',
    });
  });

  test('any other thrown error still exits 1', () => {
    expect(formatThrown(new Error('ECONNREFUSED'), { commandLabel: 'runs get' }).exitCode).toBe(1);
  });
});
