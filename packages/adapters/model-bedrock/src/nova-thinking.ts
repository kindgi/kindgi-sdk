// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Amazon Nova writes its chain of thought into the answer text when tools are in play:
 * `<thinking>…</thinking>` before the reply. Other vendors keep reasoning apart, and a
 * `ModelCallResult` has no slot for reasoning text, so for a Nova model one leading block is
 * removed from the answer, with a warning saying so (the model-call record keeps the warning).
 * Only an exact leading pair is touched: a block elsewhere in the text, or one that isn't
 * closed, is left as it came.
 */

import type { ModelCallResult } from '@kindgi/capabilities';

/** The warning code a removed `<thinking>` block leaves on the result. */
export const NOVA_THINKING_REMOVED = 'reasoning-text-removed';

/** A Nova model id or inference profile (`us.amazon.nova-pro-v1:0`, or an ARN naming one). */
const NOVA = /(^|[.:/])amazon\.nova-/;
/** One block at the very start of the text (whitespace aside), closed. */
const LEADING_THINKING = /^\s*<thinking>[\s\S]*?<\/thinking>\s*/;

export const isNovaModel = (name: string): boolean => NOVA.test(name);

/** The result with one leading `<thinking>…</thinking>` block taken out of its answer. */
export function withoutLeadingThinking(result: ModelCallResult): ModelCallResult {
  const content = result.message.content;
  const found = LEADING_THINKING.exec(content);
  if (found === null) return result;
  return {
    ...result,
    message: { ...result.message, content: content.slice(found[0].length) },
    warnings: [
      ...(result.warnings ?? []),
      {
        code: NOVA_THINKING_REMOVED,
        message: `${result.provider.model} wrote its reasoning into the answer: the leading <thinking> block (${found[0].trim().length} characters) was removed.`,
      },
    ],
  };
}
