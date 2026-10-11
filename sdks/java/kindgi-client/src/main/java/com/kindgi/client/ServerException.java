// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** The server failed, or answered with an error this client has no category for (see {@link #serverCode()}). */
public final class ServerException extends KindgiApiException {
  private static final long serialVersionUID = 1L;

  /**
   * @param message what went wrong
   * @param status the HTTP status
   * @param serverCode the server's code
   * @param details the error's details
   * @param requestId the request id
   */
  public ServerException(String message, @Nullable Integer status, @Nullable String serverCode, @Nullable Map<String, Object> details, @Nullable String requestId) {
    super(message, status, serverCode, details, requestId, null);
  }

  @Override
  public String code() {
    return "server";
  }
}
