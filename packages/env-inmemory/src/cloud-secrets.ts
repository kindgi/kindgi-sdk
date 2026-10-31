// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type {
  EnvCloudSecretBinding,
  EnvCloudSecretListInput,
  EnvCloudSecretListPage,
  EnvCloudSecretRecord,
  EnvCloudSecretSetInput,
  EnvCloudSecretSetOutcome,
  EnvDeleteInput,
  EnvDeleteOutcome,
  EnvGetInput,
} from '@kindgi/api';
import { scopeKey } from '@kindgi/platform';
import type { Cursor } from '@kindgi/types';

export interface InMemoryEnvCloudSecretBindingOptions {
  /** Set `true` to allow booting under `NODE_ENV === 'production'`. Default `false`. */
  readonly productionSafe?: boolean;
  /** Deterministic clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Reference in-memory `EnvCloudSecretBinding`, for dev and tests: the env
 * names set to a cloud secret, keyed `(scope, envName, name)` as env
 * values are. It keeps each one's path, as given (the route checks it),
 * and never reads a value. Pages run in name order, the cursor being the
 * last name given. Refuses to boot in production.
 */
export function createInMemoryEnvCloudSecretBinding(
  options: InMemoryEnvCloudSecretBindingOptions = {},
): EnvCloudSecretBinding {
  if (!options.productionSafe && process.env.NODE_ENV === 'production') {
    throw new Error(
      '@kindgi/env-inmemory refuses to boot with NODE_ENV=production; supply { productionSafe: true } if this is a parity test.',
    );
  }
  const now = options.now ?? (() => Date.now());
  // `scopeKey|envName` → name → record.
  const store = new Map<string, Map<string, EnvCloudSecretRecord>>();
  const bucket = (input: EnvGetInput | EnvCloudSecretListInput) => {
    const key = `${scopeKey(input.scope)}|${input.envName as unknown as string}`;
    let byName = store.get(key);
    if (byName === undefined) {
      byName = new Map();
      store.set(key, byName);
    }
    return byName;
  };
  let seq = 0;
  const nextTimestamp = (): string => {
    seq += 1;
    return new Date(now() + seq).toISOString();
  };

  return {
    async get(input: EnvGetInput): Promise<EnvCloudSecretRecord | null> {
      return bucket(input).get(input.name) ?? null;
    },

    async list(input: EnvCloudSecretListInput): Promise<EnvCloudSecretListPage> {
      const after = input.cursor as unknown as string | undefined;
      const all = [...bucket(input).values()]
        .filter((r) => after === undefined || r.name > after)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const data = all.slice(0, input.limit);
      const last = data.at(-1);
      return {
        data,
        ...(all.length > data.length &&
          last !== undefined && { nextCursor: last.name as unknown as Cursor }),
      };
    },

    async set(input: EnvCloudSecretSetInput): Promise<EnvCloudSecretSetOutcome> {
      const byName = bucket(input);
      const existing = byName.get(input.name);
      const current = existing?.revision ?? 0;
      if (input.ifRevision !== undefined && input.ifRevision !== current) {
        return { kind: 'revision-conflict', currentRevision: current };
      }
      const updatedAt = nextTimestamp();
      const record: EnvCloudSecretRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        cloudSecret: input.cloudSecret,
        revision: current + 1,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
        recordId: existing?.recordId ?? randomUUID(),
      };
      byName.set(input.name, record);
      return { kind: 'ok', record };
    },

    async delete(input: EnvDeleteInput): Promise<EnvDeleteOutcome> {
      return { deleted: bucket(input).delete(input.name) };
    },
  };
}
