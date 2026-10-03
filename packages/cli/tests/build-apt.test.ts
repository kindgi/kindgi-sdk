// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { checkAptPackages, renderAptGetStep } from '../src/build/apt.js';

describe('checkAptPackages', () => {
  test('names and pinned versions pass, sorted and without duplicates', () => {
    expect(
      checkAptPackages(['tesseract-ocr', 'libmagic1', 'poppler-utils=22.02.0-2', 'libmagic1'], 'x'),
    ).toEqual({ kind: 'ok', packages: ['libmagic1', 'poppler-utils=22.02.0-2', 'tesseract-ocr'] });
    expect(checkAptPackages(undefined, 'x')).toEqual({ kind: 'ok', packages: [] });
  });

  test('anything else is refused, naming the setting — nothing reaches the RUN line', () => {
    expect(checkAptPackages('tesseract-ocr', 'the key')).toEqual({
      kind: 'err',
      message: 'the key must be a list of Debian package names',
    });
    expect(checkAptPackages(['curl; rm -rf /', 'Upper', 'ok-name'], 'the key')).toEqual({
      kind: 'err',
      message: 'the key: not a Debian package name: "curl; rm -rf /", "Upper"',
    });
  });
});

describe('renderAptGetStep', () => {
  test('one layer, no recommended extras, the lists removed; nothing for none', () => {
    expect(renderAptGetStep(['libmagic1', 'tesseract-ocr'])).toBe(
      'RUN apt-get update \\\n && apt-get install -y --no-install-recommends libmagic1 tesseract-ocr \\\n && rm -rf /var/lib/apt/lists/*',
    );
    expect(renderAptGetStep([])).toBe('');
  });
});
