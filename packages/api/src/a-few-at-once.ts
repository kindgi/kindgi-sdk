// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `read` for each of `items`, at most `atOnce` at a time, the answers in
 * the items' order. Items start in that order, each as soon as one before
 * it ends. After a failure no more start: the ones running end, then the
 * failure of the earliest item, in the items' order, is thrown. That's
 * what reading the items one after another throws, unless a failure came
 * from the reads running together (a busy database).
 */
export async function aFewAtOnce<T, R>(
  items: readonly T[],
  atOnce: number,
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const answers: R[] = [];
  let next = 0;
  let earliest: { readonly index: number; readonly error: unknown } | undefined;
  async function inTurn(): Promise<void> {
    while (earliest === undefined && next < items.length) {
      const index = next;
      next += 1;
      try {
        answers[index] = await read(items[index] as T);
      } catch (error) {
        if (earliest === undefined || index < earliest.index) earliest = { index, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(atOnce, items.length)) }, inTurn));
  if (earliest !== undefined) throw earliest.error;
  return answers;
}
