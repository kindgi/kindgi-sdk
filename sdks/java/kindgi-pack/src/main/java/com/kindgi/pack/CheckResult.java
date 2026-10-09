// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * A check's verdict: {@code passed = false} with a {@code reason} fires the guardrail's action.
 *
 * @param passed whether the run passes
 * @param reason why it doesn't
 * @param judgeResponse an LLM judge's answer, when one decided
 * @param attributes anything else to record with the verdict
 */
public record CheckResult(boolean passed, @Nullable String reason, @Nullable String judgeResponse, @Nullable Map<String, Object> attributes) {
  /** @return a pass */
  public static CheckResult pass() {
    return new CheckResult(true, null, null, null);
  }

  /**
   * @param reason why
   * @return a failure
   */
  public static CheckResult fail(String reason) {
    return new CheckResult(false, reason, null, null);
  }
}
