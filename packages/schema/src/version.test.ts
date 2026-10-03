// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { versionOf } from './version.js';

const validSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://kindgi.com/schemas/v1/flow.schema.json',
  $comment: 'schema-version: 1.0.0',
  title: 'Flow',
  type: 'object',
};

describe('versionOf', () => {
  test('extracts major from $id and semver from $comment for a valid schema', () => {
    const result = versionOf(validSchema);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.major).toBe(1);
      expect(result.value.semver).toBe('1.0.0');
    }
  });

  test('supports semver prerelease strings in $comment', () => {
    const schema = { ...validSchema, $comment: 'schema-version: 2.1.0-rc.3' };
    const result = versionOf(schema);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.semver).toBe('2.1.0-rc.3');
    }
  });

  test('supports higher major versions', () => {
    const schema = {
      ...validSchema,
      $id: 'https://kindgi.com/schemas/v42/flow.schema.json',
      $comment: 'schema-version: 42.0.0',
    };
    const result = versionOf(schema);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.major).toBe(42);
    }
  });

  test('errors when schema is not an object', () => {
    const result = versionOf('not-a-schema');
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('schema-compile-error');
      expect(result.error.message).toContain('not an object');
    }
  });

  test('errors when schema is null', () => {
    const result = versionOf(null);
    expect(result.kind).toBe('err');
  });

  test('errors when $id is missing', () => {
    const { $id: _unused, ...rest } = validSchema;
    const result = versionOf(rest);
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('schema-compile-error');
      expect(result.error.message).toContain('$id');
    }
  });

  test('errors when $id does not match the versioned URL convention', () => {
    const schema = { ...validSchema, $id: 'https://example.com/flow.json' };
    const result = versionOf(schema);
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.code).toBe('schema-compile-error');
      expect(result.error.message).toContain('does not match');
    }
  });

  test('errors when $id has no version segment', () => {
    const schema = {
      ...validSchema,
      $id: 'https://kindgi.com/schemas/flow.schema.json',
    };
    const result = versionOf(schema);
    expect(result.kind).toBe('err');
  });

  test('errors when $comment is missing', () => {
    const { $comment: _unused, ...rest } = validSchema;
    const result = versionOf(rest);
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.message).toContain('$comment');
    }
  });

  test('errors when $comment does not match the schema-version format', () => {
    const schema = { ...validSchema, $comment: 'just some comment' };
    const result = versionOf(schema);
    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.message).toContain('schema-version');
    }
  });

  test('errors when $comment has an invalid semver', () => {
    const schema = { ...validSchema, $comment: 'schema-version: 1.0' };
    const result = versionOf(schema);
    expect(result.kind).toBe('err');
  });
});
