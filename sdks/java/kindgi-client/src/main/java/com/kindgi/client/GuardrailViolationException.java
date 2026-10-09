// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** A guardrail refused the call: {@link #violations()} says which and why. */
public final class GuardrailViolationException extends KindgiApiException {
  private static final long serialVersionUID = 1L;

  /** @serial the violations */
  private final transient List<Map<String, Object>> violations;
  /** @serial the checks that couldn't run */
  private final transient List<Map<String, Object>> evaluationErrors;

  /**
   * @param message what went wrong
   * @param violations the guardrails that refused it
   * @param evaluationErrors the checks that couldn't run
   * @param status the HTTP status
   * @param serverCode the server's code
   * @param details the error's details
   * @param requestId the request id
   */
  public GuardrailViolationException(String message, List<Map<String, Object>> violations, List<Map<String, Object>> evaluationErrors, @Nullable Integer status, @Nullable String serverCode, @Nullable Map<String, Object> details, @Nullable String requestId) {
    super(message, status, serverCode, details, requestId, null);
    this.violations = List.copyOf(violations);
    this.evaluationErrors = List.copyOf(evaluationErrors);
  }

  /** @return the guardrails that refused the call */
  public List<Map<String, Object>> violations() {
    return violations;
  }

  /** @return the checks that couldn't run */
  public List<Map<String, Object>> evaluationErrors() {
    return evaluationErrors;
  }

  @Override
  public String code() {
    return "guardrail-violation";
  }
}
