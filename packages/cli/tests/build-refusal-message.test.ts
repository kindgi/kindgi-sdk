// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import { BuildServiceRefusal, describeBuildRefusal } from '../src/build/hosted.js';

/**
 * A build service's refusal on stderr: the service's message ends as a
 * sentence, so the wait the CLI adds after it never runs into it.
 */

const PREFIX = 'The build service refused the build (HTTP 429, rate-limit-exceeded)';

function refusal(message: string, retryAfterSeconds?: number): BuildServiceRefusal {
  return new BuildServiceRefusal(429, 'rate-limit-exceeded', message, retryAfterSeconds);
}

describe('describeBuildRefusal', () => {
  test('a message without a full stop gets one before the wait', () => {
    expect(describeBuildRefusal(refusal('One build at a time, send it again', 10))).toBe(
      `${PREFIX}: One build at a time, send it again. Try again in 10 s.\n`,
    );
  });

  test('a message without a full stop gets one when no wait is asked', () => {
    expect(describeBuildRefusal(refusal('One build at a time'))).toBe(
      `${PREFIX}: One build at a time.\n`,
    );
  });

  test('a message that ends a sentence is kept as it is', () => {
    expect(describeBuildRefusal(refusal('One build at a time.', 10))).toBe(
      `${PREFIX}: One build at a time. Try again in 10 s.\n`,
    );
    expect(describeBuildRefusal(refusal('Is another build running?'))).toBe(
      `${PREFIX}: Is another build running?\n`,
    );
    expect(describeBuildRefusal(refusal('Wait for it!'))).toBe(`${PREFIX}: Wait for it!\n`);
  });

  test('a closing quote or bracket after the full stop is kept, with no stop added', () => {
    expect(describeBuildRefusal(refusal('One build at a time (see the build log.)', 10))).toBe(
      `${PREFIX}: One build at a time (see the build log.) Try again in 10 s.\n`,
    );
    expect(describeBuildRefusal(refusal('The queue says "full."'))).toBe(
      `${PREFIX}: The queue says "full."\n`,
    );
  });

  test('space around the message is trimmed before the stop is added', () => {
    expect(describeBuildRefusal(refusal('  One build at a time \n', 10))).toBe(
      `${PREFIX}: One build at a time. Try again in 10 s.\n`,
    );
  });

  test('an empty message leaves the line ending at the code', () => {
    expect(describeBuildRefusal(refusal(' ', 10))).toBe(`${PREFIX}. Try again in 10 s.\n`);
    expect(describeBuildRefusal(refusal(''))).toBe(`${PREFIX}.\n`);
  });

  test('a full stop inside the message does not end it', () => {
    expect(describeBuildRefusal(refusal('One build per 10 s. Send it again', 10))).toBe(
      `${PREFIX}: One build per 10 s. Send it again. Try again in 10 s.\n`,
    );
  });
});
