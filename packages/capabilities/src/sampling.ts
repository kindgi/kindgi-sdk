// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Sampling settings for a model that may not take them. Some models
 * reject a non-default `temperature` outright (Anthropic's Claude 4.7
 * and later; OpenAI's GPT-6 at any reasoning effort but `none`). Their
 * `ModelInfo.sampling` is `false`, and every adapter asks this one place
 * what to send: the call goes out without the temperature, and the
 * answer carries a `sampling-unsupported` warning saying so, instead of
 * failing on the vendor's 400.
 */

import type { ModelCallInput, ModelCallWarning, ModelInfo } from './types.js';

/** The warning code an answer carries when its temperature was left out. */
export const SAMPLING_UNSUPPORTED = 'sampling-unsupported';

export interface Sampling {
  /** The temperature to send: absent when unset, or when the model doesn't take one. */
  readonly temperature?: number;
  /** One `sampling-unsupported` warning when a temperature was left out. */
  readonly warnings: readonly ModelCallWarning[];
}

/** What to send of a call's sampling settings, for this model. */
export function samplingFor(
  model: Pick<ModelInfo, 'name' | 'sampling'>,
  input: Pick<ModelCallInput, 'temperature'>,
): Sampling {
  if (input.temperature === undefined) return { warnings: [] };
  if (model.sampling !== false) return { temperature: input.temperature, warnings: [] };
  return {
    warnings: [
      {
        code: SAMPLING_UNSUPPORTED,
        message: `${model.name} doesn't take a temperature, so the call went without one (it asked for ${input.temperature}).`,
      },
    ],
  };
}
