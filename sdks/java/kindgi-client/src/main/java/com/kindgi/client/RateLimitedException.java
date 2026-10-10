// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** Too many calls (429); retried by the client first when the call is safe to repeat. */
public final class RateLimitedException extends KindgiApiException {
  private static final long serialVersionUID = 1L;

  /** @serial how long to wait, when the server said */
  private final @Nullable Double retryAfterSeconds;

  /**
   * @param message what went wrong
   * @param retryAfterSeconds how long to wait, when the server said
   * @param status the HTTP status
   * @param serverCode the server's code
   * @param details the error's details
   * @param requestId the request id
   */
  public RateLimitedException(String message, @Nullable Double retryAfterSeconds, @Nullable Integer status, @Nullable String serverCode, @Nullable Map<String, Object> details, @Nullable String requestId) {
    super(message, status, serverCode, details, requestId, null);
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** @return how long to wait before trying again, in seconds, or {@code null} */
  public @Nullable Double retryAfterSeconds() {
    return retryAfterSeconds;
  }

  @Override
  public String code() {
    return "rate-limited";
  }
}
