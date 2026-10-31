// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Semver } from '@kindgi/types';

import type { PinnedResolveInput, PinnedVersionBinding } from '../../src/index.js';

/**
 * A pinned-version binding holding tool pins (tool id → version), each for
 * whichever project asks; every lookup is recorded in `asked`. It takes no
 * writes.
 */
export function toolPinsBinding(
  pins: Readonly<Record<string, string>>,
  asked: PinnedResolveInput[] = [],
): PinnedVersionBinding {
  const unused = async (): Promise<never> => {
    throw new Error('not used here');
  };
  return {
    async resolve(input) {
      asked.push(input);
      const version = input.kind === 'tool' ? pins[input.itemId] : undefined;
      if (version === undefined || input.projectId === undefined) return null;
      return {
        version: version as Semver,
        scope: { kind: 'project', projectId: input.projectId },
      };
    },
    list: unused,
    history: unused,
    pin: unused,
    unpin: unused,
  };
}
