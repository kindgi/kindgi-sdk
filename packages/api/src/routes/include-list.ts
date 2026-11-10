// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A list's `?include=`: the extras it adds, one or more, comma-separated
 * (`include=output,waitingFor`, the spec's form) or repeated
 * (`include=output&include=waitingFor`). Empty items are skipped, so
 * `include=` adds nothing. `raw` is every `include` value
 * (`c.req.queries('include')`).
 *
 * A value the list doesn't know is refused. The message starts with
 * ``Unknown `include` value(s)``, which a client matches to tell an older
 * runtime (one that doesn't know a value yet) from another bad input, so
 * a reword keeps that start.
 */
export function includeListOf<V extends string>(
  raw: readonly string[] | undefined,
  known: readonly V[],
):
  | { readonly kind: 'ok'; readonly value: ReadonlySet<V> }
  | { readonly kind: 'err'; readonly message: string } {
  const given = (raw ?? [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');
  const isKnown = (v: string): v is V => (known as readonly string[]).includes(v);
  const unknown = given.filter((v) => !isKnown(v));
  if (unknown.length > 0) {
    return {
      kind: 'err',
      message: `Unknown \`include\` value(s): ${unknown.join(', ')}. Expected one or more of: ${known.join(', ')}`,
    };
  }
  return { kind: 'ok', value: new Set(given.filter(isKnown)) };
}
