// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  ConnectionRejectedError,
  ConnectionRenewError,
  connectionRejectionOf,
  isConnectionRejectedError,
  isConnectionRenewError,
  toolSecretNames,
  validateToolManifest,
} from '../src/index.js';

const manifest = {
  id: 'acme.send-follow-up',
  description: 'Send a follow-up as the person.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
};

describe('needsSpec.connections', () => {
  test('a tool declares the connections it acts with, by its own name for each', () => {
    const checked = validateToolManifest({
      ...manifest,
      needsSpec: {
        connections: {
          mail: { app: 'google', permissions: ['gmail.send'], as: 'person' },
          repo: { app: 'github', permissions: ['issues.read', 'issues.write'], as: 'company' },
        },
      },
    });
    expect(checked.kind).toBe('ok');
  });

  test.each([
    [
      'an owner other than person or company',
      { mail: { app: 'google', permissions: ['gmail.send'], as: 'tenant' } },
    ],
    ['no permissions', { mail: { app: 'google', permissions: [], as: 'person' } }],
    [
      'a permission twice',
      { mail: { app: 'google', permissions: ['gmail.send', 'gmail.send'], as: 'person' } },
    ],
    [
      'a permission key that is not a key',
      { mail: { app: 'google', permissions: ['Gmail Send'], as: 'person' } },
    ],
    [
      'an app id that is not an entry id',
      { mail: { app: 'Google', permissions: ['gmail.send'], as: 'person' } },
    ],
    ['no app', { mail: { permissions: ['gmail.send'], as: 'person' } }],
    [
      'a field it does not know',
      { mail: { app: 'google', permissions: ['gmail.send'], as: 'person', scope: 'x' } },
    ],
    [
      'a name that is not a plain name',
      { 'my mail': { app: 'google', permissions: ['gmail.send'], as: 'person' } },
    ],
  ])('refuses %s', (_what, connections) => {
    const checked = validateToolManifest({ ...manifest, needsSpec: { connections } });
    expect(checked.kind).toBe('err');
    if (checked.kind === 'err') expect(checked.error.code).toBe('invalid-tool-definition');
  });

  test("an HTTP spec's connection authorization must name a declared connection", () => {
    const spec = {
      kind: 'http',
      method: 'GET',
      urlTemplate: 'https://api.acme.example/notes',
      authorization: { kind: 'connection', connection: 'notes' },
    };
    const undeclared = validateToolManifest({ ...manifest, spec });
    expect(undeclared.kind).toBe('err');
    if (undeclared.kind === 'err' && undeclared.error.code === 'invalid-tool-definition') {
      expect(undeclared.error.issues).toEqual([
        {
          path: '/spec/authorization/connection',
          message: 'must name a connection needsSpec.connections declares',
        },
      ]);
    }
    const declared = validateToolManifest({
      ...manifest,
      spec,
      needsSpec: {
        connections: { notes: { app: 'acme', permissions: ['notes.read'], as: 'person' } },
      },
    });
    expect(declared.kind).toBe('ok');
  });

  test("a connection's authorization sends no secret", () => {
    expect(
      toolSecretNames({
        needsSpec: { secrets: { SEARCH_KEY: { type: 'string' } } },
        spec: {
          kind: 'http',
          method: 'GET',
          urlTemplate: 'https://api.acme.example/notes',
          authorization: { kind: 'connection', connection: 'notes' },
        },
      }),
    ).toEqual(['SEARCH_KEY']);
  });
});

describe('connectionRejectionOf', () => {
  test('finds the refusal an error is, or wraps up to three causes deep', () => {
    const rejected = new ConnectionRejectedError('mail', 'the app answered 401');
    const found = { connection: 'mail', message: 'the app answered 401' };
    expect(connectionRejectionOf(rejected)).toEqual(found);
    let wrapped: unknown = rejected;
    for (const depth of [1, 2, 3]) {
      wrapped = new Error(`wrapped ${depth}`, { cause: wrapped });
      expect(connectionRejectionOf(wrapped)).toEqual(found);
    }
    expect(connectionRejectionOf(new Error('wrapped 4', { cause: wrapped }))).toBe(undefined);
  });

  test("a pack tool's answer counts too, and its default message names the connection", () => {
    expect(connectionRejectionOf({ code: 'connection-rejected', connection: 'repos' })).toEqual({
      connection: 'repos',
      message: 'the app refused the connection "repos"',
    });
    const fromAnotherCopy = Object.assign(new Error('x'), {
      [Symbol.for('kindgi.tools.connection-rejected')]: true,
      connection: 'mail',
    });
    expect(connectionRejectionOf(fromAnotherCopy)?.connection).toBe('mail');
  });

  test('none: another error, one naming no connection, a non-object, a cycle', () => {
    expect(connectionRejectionOf(new Error('boom'))).toBe(undefined);
    expect(connectionRejectionOf({ code: 'connection-rejected' })).toBe(undefined);
    expect(connectionRejectionOf('connection-rejected')).toBe(undefined);
    expect(connectionRejectionOf(undefined)).toBe(undefined);
    const looped: { message: string; cause?: unknown } = { message: 'loop' };
    looped.cause = looped;
    expect(connectionRejectionOf(looped)).toBe(undefined);
  });
});

describe('ConnectionRejectedError', () => {
  test('names the connection, and says so by default', () => {
    const error = new ConnectionRejectedError('mail');
    expect(error.connection).toBe('mail');
    expect(error.name).toBe('ConnectionRejectedError');
    expect(error.code).toBe('connection-rejected');
    expect(error.message).toBe('the app refused the connection "mail"');
    expect(new ConnectionRejectedError('mail', 'got status 401').message).toBe('got status 401');
  });

  test('is recognized from another copy of the package, by its registered symbol', () => {
    expect(isConnectionRejectedError(new ConnectionRejectedError('mail'))).toBe(true);
    const fromAnotherCopy = Object.assign(new Error('x'), {
      [Symbol.for('kindgi.tools.connection-rejected')]: true,
      connection: 'mail',
    });
    expect(isConnectionRejectedError(fromAnotherCopy)).toBe(true);
    expect(isConnectionRejectedError(new Error('x'))).toBe(false);
    expect(isConnectionRejectedError(null)).toBe(false);
  });
});

describe('ConnectionRenewError', () => {
  test('names the connection and carries its code', () => {
    const error = new ConnectionRenewError('mail');
    expect(error.connection).toBe('mail');
    expect(error.code).toBe('connection-renew-failed');
    expect(error.name).toBe('ConnectionRenewError');
    expect(error.message).toBe('the app couldn\'t renew the connection "mail" just now');
  });

  test('is recognized from another copy of the package, and is not a rejection', () => {
    const error = new ConnectionRenewError('mail', 'the token endpoint timed out');
    expect(isConnectionRenewError(error)).toBe(true);
    expect(isConnectionRejectedError(error)).toBe(false);
    expect(isConnectionRenewError(new ConnectionRejectedError('mail'))).toBe(false);
    const fromAnotherCopy = Object.assign(new Error('x'), {
      [Symbol.for('kindgi.tools.connection-renew-failed')]: true,
    });
    expect(isConnectionRenewError(fromAnotherCopy)).toBe(true);
    expect(isConnectionRenewError(undefined)).toBe(false);
  });
});
