// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** The server refused the request as invalid (400): {@link #issues()} says what. */
public final class InvalidRequestException extends KindgiApiException {
  private static final long serialVersionUID = 1L;

  /** @serial the problems */
  private final transient List<Map<String, Object>> issues;

  /**
   * @param message what went wrong
   * @param issues the problems, as the server lists them
   * @param status the HTTP status
   * @param serverCode the server's code
   * @param details the error's details
   * @param requestId the request id
   */
  public InvalidRequestException(String message, List<Map<String, Object>> issues, @Nullable Integer status, @Nullable String serverCode, @Nullable Map<String, Object> details, @Nullable String requestId) {
    super(message, status, serverCode, details, requestId, null);
    this.issues = List.copyOf(issues);
  }

  /** @return the problems, as the server lists them */
  public List<Map<String, Object>> issues() {
    return issues;
  }

  @Override
  public String code() {
    return "invalid-request";
  }
}
