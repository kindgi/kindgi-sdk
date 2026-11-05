// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/api/run-result`: what a place that shows a run's result draws
 * from, so the console and a chat's run view say the same: the status
 * words, the answer a run gave, and that answer split into blocks by its
 * shape. Plain functions and data, with no runtime dependencies, so a
 * browser bundle can import it.
 */

export { answerOfText, answerValue } from './answer.js';
export { type AnswerBlock, type AnswerBlocks, RESULT_LIMIT, answerBlocks } from './blocks.js';
export { clipText } from './clip-text.js';
export { RUN_STATUS_WORDS } from './words.js';
