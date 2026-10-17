// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.concurrent.CompletionStage;

/**
 * A guardrail's check that answers later: a {@link CompletionStage} of its verdict.
 *
 * @param <C> the config type
 */
@FunctionalInterface
public interface AsyncCheckHandler<C> {
  /**
   * @param config the guardrail's config, checked against its schema
   * @param trace the run to check
   * @return the verdict, later
   * @throws Exception when the check fails before it starts its work
   */
  CompletionStage<CheckResult> check(C config, RunTrace trace) throws Exception;
}
