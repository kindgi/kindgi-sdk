// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Kindgi login profiles: named logins in `~/.kindgi/config.json`, one per
 * runtime, beside the login without a name.
 *
 * ```json
 * { "apiUrl": "…", "token": "…", "profiles": { "prod": { "apiUrl": "…", "token": "…" } } }
 * ```
 *
 * A command uses a profile only when it names it: `--profile prod`, or
 * KINDGI_PROFILE=prod in that shell. A profile's key is never found by its
 * address, and no current profile is stored. `kindgi auth login --profile`
 * saves one; `kindgi auth list` and `kindgi auth logout` show and remove
 * them. `kindgi dev` refuses `--profile` and ignores KINDGI_PROFILE: a dev
 * runtime is local.
 */

/** A profile's name: lowercase letters, digits and `-`, 1 to 32, starting with a letter. */
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** What a name has to be, for a refusal. */
export const PROFILE_NAME_RULE =
  'lowercase letters, digits and -, 1 to 32 characters, starting with a letter';

/** The env var that names a profile for a shell. */
export const PROFILE_ENV = 'KINDGI_PROFILE';

/** A profile as the CLI shows it: its name and address, never its key. */
export interface ProfileSummary {
  readonly name: string;
  readonly apiUrl?: string;
  /** Why it can't be used (a malformed entry); `undefined` when it can. */
  readonly problem?: string;
}

/** A usable profile, with its key: config.ts only, never shown. */
export interface ProfileLogin {
  readonly apiUrl: string;
  readonly token: string;
}

/** What `~/.kindgi/config.json`'s `profiles` holds. */
export interface ReadProfiles {
  /** The usable ones, by name. */
  readonly usable: ReadonlyMap<string, ProfileLogin>;
  /** Every entry, usable or not, in the file's order. */
  readonly summaries: readonly ProfileSummary[];
  /** Why `profiles` itself can't be read (it isn't an object); then no profile is usable. */
  readonly malformed?: string;
}

const NONE: ReadProfiles = { usable: new Map(), summaries: [] };

/**
 * Read a config file's `profiles`. A malformed entry (not an object, no
 * `apiUrl` or `token`, or a name outside `PROFILE_NAME`) is kept with its
 * problem: it's refused only when it's named, and never used for any
 * address.
 */
export function readProfiles(raw: unknown): ReadProfiles {
  if (raw === undefined) return NONE;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...NONE, malformed: "`profiles` isn't an object" };
  }
  const usable = new Map<string, ProfileLogin>();
  const summaries: ProfileSummary[] = [];
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    const fields =
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : undefined;
    const apiUrl = given(fields?.apiUrl);
    const token = given(fields?.token);
    const problem = entryProblem(name, fields, apiUrl, token);
    summaries.push({
      name,
      ...(apiUrl !== undefined && { apiUrl }),
      ...(problem !== undefined && { problem }),
    });
    if (problem === undefined && apiUrl !== undefined && token !== undefined) {
      usable.set(name, { apiUrl, token });
    }
  }
  return { usable, summaries };
}

/** The names a file holds, for a refusal: "prod and staging", or "none". */
export function heldNames(profiles: readonly ProfileSummary[]): string {
  const names = profiles.map((p) => p.name);
  if (names.length === 0) return 'none';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Why a `profiles` entry can't be used; `undefined` when it can. */
function entryProblem(
  name: string,
  fields: Record<string, unknown> | undefined,
  apiUrl: string | undefined,
  token: string | undefined,
): string | undefined {
  if (!PROFILE_NAME.test(name)) return `its name isn't one the CLI takes (${PROFILE_NAME_RULE})`;
  if (fields === undefined) return "it isn't an object";
  if (apiUrl === undefined) return 'it has no apiUrl';
  if (token === undefined) return 'it has no token';
  return undefined;
}

function given(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
