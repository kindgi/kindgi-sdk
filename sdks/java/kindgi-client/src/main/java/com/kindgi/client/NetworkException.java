// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import org.jspecify.annotations.Nullable;

/** The call got no usable answer: the connection failed, it timed out, or the body wasn't JSON. */
public final class NetworkException extends KindgiApiException {
  private static final long serialVersionUID = 1L;

  /**
   * @param message what went wrong
   * @param status the HTTP status, when there was an answer
   * @param cause the cause
   */
  public NetworkException(String message, @Nullable Integer status, @Nullable Throwable cause) {
    super(message, status, null, null, null, cause);
  }

  @Override
  public String code() {
    return "network";
  }
}
