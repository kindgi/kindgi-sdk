// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

/**
 * A guardrail's check: its config (checked against the config schema, bound to its type) and the
 * run it evaluates.
 *
 * @param <C> the config type
 */
@FunctionalInterface
public interface CheckHandler<C> {
  /**
   * @param config the guardrail's config
   * @param trace the run
   * @return the verdict
   * @throws Exception any failure: the call answers {@code handler-throw}
   */
  CheckResult check(C config, RunTrace trace) throws Exception;
}
