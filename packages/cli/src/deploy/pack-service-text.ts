// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What a deployment's pack service is doing, said to its owner: why it has
 * none yet (`problem.code`), why none is wanted for it (`retired`), and why
 * it runs on the values it was last given (`packEnvProblem.code`).
 * `kindgi deploy` says them while it waits, and `kindgi deployments get`
 * when asked. One wording, so both say the same.
 */

import { type PackEnvHintTarget, packEnvSetCommand } from '../env/pack-env-hint.js';

/** Why a deployment has no pack service yet, by its `problem.code`. */
const PACK_SERVICE_PROBLEMS: Readonly<Record<string, string>> = {
  'tenant-not-provisioned': 'your workspace has nowhere to run pack services yet',
  'capacity-unavailable': 'there is no room for another pack service just now',
  'service-start-failed': "the pack's image was deployed but didn't start",
  'image-not-allowed': "the image is outside your workspace's own repository",
  'endpoint-url-invalid': "the platform couldn't connect the pack service",
  'endpoint-host-not-allowed': "the platform couldn't connect the pack service",
  'endpoint-name-mismatch': "the platform couldn't connect the pack service",
  'endpoint-unreachable': "the pack service didn't answer",
  'endpoint-info-mismatch': 'the pack service answered as another pack or version',
  'pack-env-missing': "a name the pack needs in its env isn't set",
  'pack-env-secret-not-yet': 'a name the pack reads from its env is set only as a secret',
  'pack-env-ambiguous':
    'a name the pack reads from its env is set more than one way: as a plain value, a secret or a cloud secret',
  'pack-env-cloud-secret-unsupported':
    "a name the pack reads from its env is set to a cloud secret, which this pack service's host can't mount: set it as a value or a secret instead, or ask your operator",
  'pack-env-secret-capacity':
    'a name the pack reads from its env is set as a secret, and there is no room for a pack service that can be given one just now',
  'pack-env-secret-too-large':
    'a secret the pack reads from its env is over 32 KiB, the most a pack service can be given',
  'pack-env-name-too-long':
    'a name the pack reads from its env as a secret is too long to keep as one: shorten it in the pack',
  'pack-env-secret-unreadable':
    "a secret the pack reads from its env can't be read just now: the platform's team is told, and it's tried again",
  'pack-env-secrets-unaudited':
    "the platform can't give the pack its secrets just now: its team is told, and it's tried again",
};

/** Why no pack service is wanted for a cleared deployment now, by its `retired` reason. */
const PACK_SERVICE_RETIRED: Readonly<Record<string, string>> = {
  superseded:
    'a later deploy ships every tool version and check this one does, so no new call reaches it',
  'tenant-closing': 'your workspace is closing',
  'tenant-suspended': "your workspace is suspended, until it's restored",
  'project-suspended': "its project is suspended, until it's restored",
  'pack-suspended': "its pack is suspended, until it's restored",
};

/** Why there's no pack service yet: by its code, or in general for a code a later runtime names. */
export function packServiceProblemText(code: string): string {
  return PACK_SERVICE_PROBLEMS[code] ?? 'not ready yet';
}

/** Why none is wanted for it now: by its reason, or in general for one a later runtime names. */
export function packServiceRetiredText(reason: string): string {
  return PACK_SERVICE_RETIRED[reason] ?? 'none is wanted for it now';
}

/**
 * Why a ready pack service runs on the values it was last given, by its
 * `packEnvProblem.code`: a name that keeps the newest from it (the words
 * a pending one has for it), newest values it was given and didn't start
 * with, or a name newly set only as a secret, which it can't be given. The
 * second is tried again for an hour from when it was recorded
 * (`PACK_ENV_RETRY_MS` in `@kindgi/api`); for the third, build the pack
 * again and deploy that build, which makes a new deployment. `undefined`
 * for a code a later runtime names: it's said by its code.
 */
export function packEnvHeldText(code: string): string | undefined {
  if (code === 'pack-env-update-failed') {
    return "its newest values were given to it, but it didn't start with them. It's tried again for an hour from then";
  }
  if (code === 'pack-env-secret-redeploy') {
    return "a name the pack reads from its env is newly set only as a secret, which this pack service can't be given. Build the pack again and deploy that build: the new deployment's pack service can be given it";
  }
  return code.startsWith('pack-env-') ? PACK_SERVICE_PROBLEMS[code] : undefined;
}

/**
 * What to do about newest values a pack service didn't start with: a value
 * set again is newer values, which are tried too.
 */
export function packEnvRetryLine(target: PackEnvHintTarget): string {
  return `Setting one of its names again tries again: \`${packEnvSetCommand(target)}\`.`;
}
