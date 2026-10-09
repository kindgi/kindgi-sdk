// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** The call conflicts with the current state (409): already registered, already decided, not pinned, … */
public final class ConflictException extends KindgiApiException {
  private static final long serialVersionUID = 1L;

  /**
   * @param message what went wrong
   * @param status the HTTP status
   * @param serverCode the server's code
   * @param details the error's details
   * @param requestId the request id
   */
  public ConflictException(String message, @Nullable Integer status, @Nullable String serverCode, @Nullable Map<String, Object> details, @Nullable String requestId) {
    super(message, status, serverCode, details, requestId, null);
  }

  @Override
  public String code() {
    return "conflict";
  }
}
