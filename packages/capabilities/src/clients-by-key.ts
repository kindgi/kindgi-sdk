// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

/**
 * An adapter's SDK clients, one per key it was called with. Calls that
 * take turns with two keys (a run in each of two projects, each project
 * with a key of its own) each reuse their own client, and whatever it
 * holds (an auth client, a token), where a single slot would build a client
 * on every turn. A rotated key builds a new client; the old one goes once
 * `max` newer keys are used.
 *
 * Held by a SHA-256 of the key, never the key itself. At most `max`
 * clients (default 16), the least recently used dropped first.
 *
 * Node only (`node:crypto`): it's the `@kindgi/capabilities/clients-by-key`
 * entry, apart from the package's runtime-neutral main entry.
 */
export interface ClientsByKey<C> {
  /** The client for `key`: the one built for it before, else `build()`'s, kept. */
  get(key: string, build: () => C): C;
}

export function createClientsByKey<C>(max = 16): ClientsByKey<C> {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`createClientsByKey: max must be a whole number, 1 or more, not ${max}`);
  }
  // A Map keeps insertion order: an entry set again is the newest.
  const clients = new Map<string, C>();
  return {
    get(key, build) {
      const id = createHash('sha256').update(key).digest('base64url');
      const known = clients.get(id);
      if (known !== undefined) {
        clients.delete(id);
        clients.set(id, known);
        return known;
      }
      const client = build();
      clients.set(id, client);
      if (clients.size > max) {
        const oldest = clients.keys().next();
        if (oldest.done !== true) clients.delete(oldest.value);
      }
      return client;
    },
  };
}
