// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `read` for each of `items`, at most `atOnce` at a time, the answers in
 * the items' order. Items start in that order: the first `atOnce`
 * together, then the next one each time one running ends. After a
 * failure no more start: the ones running end, then the failure of the
 * earliest item, in the items' order, is thrown. That's what reading the
 * items one after another throws, unless a failure came from the reads
 * running together (a busy database).
 */
export async function aFewAtOnce<T, R>(
  items: readonly T[],
  atOnce: number,
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const answers: R[] = [];
  let next = 0;
  // The earliest item that failed, and its failure; `items.length` while
  // none has. An item that failed was taken, so `next` is past it, and
  // none starts after it.
  let earliest = items.length;
  let failure: unknown;
  async function inTurn(): Promise<void> {
    while (next < earliest) {
      const index = next;
      next += 1;
      try {
        answers[index] = await read(items[index] as T);
      } catch (error) {
        if (index < earliest) {
          earliest = index;
          failure = error;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(atOnce, items.length)) }, inTurn));
  if (earliest < items.length) throw failure;
  return answers;
}
