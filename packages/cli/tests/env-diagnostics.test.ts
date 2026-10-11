// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The lines `kindgi dev` and `kindgi env` print for an env file's problems. */

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { describeEnvDiagnostics } from '../src/env/project-env.js';

describe('describeEnvDiagnostics', () => {
  const packDir = '/work/acme';
  const source = join(packDir, '.env');

  test('a key that refers to itself and that the environment lacks says so (T377)', () => {
    expect(
      describeEnvDiagnostics(packDir, [
        { kind: 'unresolved', key: 'ANTHROPIC_API_KEY', ref: 'ANTHROPIC_API_KEY', source },
        { kind: 'unresolved', key: 'ACME_URL', ref: 'ACME_HOST', source },
      ]),
    ).toEqual([
      '.env: ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY} takes the environment\'s ANTHROPIC_API_KEY, and the environment doesn\'t have it — expanded to ""',
      '.env: ACME_URL references ${ACME_HOST}, which no env file (or the environment) defines — expanded to ""',
    ]);
  });
});
