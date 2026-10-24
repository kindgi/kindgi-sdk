// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { KindgiClient, LicenseStatus } from '@kindgi/client';

import { DEFAULT_RUNTIME_IMAGE } from './runtime-image.js';

/**
 * Which runtime `kindgi dev` runs: the release this CLI pins (`pinned`),
 * an image the developer named (`--runtime-image`), or one they run
 * themselves (`--runtime-url`). It decides the way to a newer one.
 */
export type DevRuntimeSource = 'pinned' | 'image' | 'url';

/** Which runtime `kindgi dev` runs, from its flags. */
export function devRuntimeSource(args: {
  readonly runtimeUrl: string | undefined;
  readonly runtimeImage: string;
}): DevRuntimeSource {
  if (args.runtimeUrl !== undefined) return 'url';
  return args.runtimeImage === DEFAULT_RUNTIME_IMAGE ? 'pinned' : 'image';
}

/** How the runtime's refusal of a preview build past its end starts (its `license-gate.ts`). */
const PREVIEW_REFUSAL = 'This preview build of the Kindgi runtime';

/**
 * What to add when the runtime stopped while starting because its preview
 * build is past its end, and `kindgi dev` didn't run the release its CLI
 * pins: the runtime's own text says to update the CLI, which changes only
 * the pinned one. Empty otherwise.
 */
export function previewRefusalHint(message: string, source: DevRuntimeSource): string {
  return source !== 'pinned' && message.includes(PREVIEW_REFUSAL) ? `\n${NEWER[source]}` : '';
}

/**
 * The warning for a preview runtime near the end of its life: before
 * Kindgi 1.0, a release stops starting 90 days after it was released.
 * From 30 days before, and once past it (a runtime started before then,
 * still running), `kindgi dev` says so with the way to a newer one.
 * `undefined` when there's nothing to say: no expiry (a 1.0 release, a
 * build from source, a production key), more than 30 days left, or a
 * runtime too old to report it.
 */
export function previewExpiryWarning(
  status: LicenseStatus | undefined,
  source: DevRuntimeSource,
): string | undefined {
  const preview = status?.preview;
  if (preview === undefined || preview.standing === 'valid') return undefined;
  const on = preview.expiresAt.slice(0, 10);
  const when =
    preview.standing === 'expired'
      ? `expired on ${on}: it runs on, but won't start again`
      : `stops starting on ${on}, in ${preview.daysLeft} day${preview.daysLeft === 1 ? '' : 's'}`;
  return `⚠ This preview runtime (${preview.version}) ${when}. Preview releases stop starting 90 days after their release, until Kindgi 1.0. ${NEWER[source]}`;
}

/**
 * The runtime's license status, for the warning; `undefined` when it can't
 * be read, whatever the reason: the warning never stops `kindgi dev`.
 */
export async function readLicenseStatus(
  client: Pick<KindgiClient, 'license'>,
): Promise<LicenseStatus | undefined> {
  try {
    return await client.license.get();
  } catch {
    return undefined;
  }
}

const NEWER: Readonly<Record<DevRuntimeSource, string>> = {
  pinned:
    'Update the Kindgi CLI (`@kindgi/cli`, or `kindgi-cli` from PyPI) to its newest release: `kindgi dev` runs the runtime release the CLI pins.',
  image:
    'Run a newer runtime image (`--runtime-image`), or drop the flag to run the one this CLI pins.',
  url: 'Run a newer runtime release at `--runtime-url`.',
};
