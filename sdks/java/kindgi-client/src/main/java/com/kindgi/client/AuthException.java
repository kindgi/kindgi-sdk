// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** The call isn't authenticated, or isn't allowed (401, 403). */
public final class AuthException extends KindgiApiException {
  private static final long serialVersionUID = 1L;

  /** Why the call was refused. */
  public enum Reason {
    /** No token, or one the server doesn't accept. */
    UNAUTHENTICATED,
    /** The token is valid, but not for this. */
    FORBIDDEN,
    /** The token has expired. */
    TOKEN_EXPIRED
  }

  /** @serial why */
  private final Reason reason;

  /**
   * @param message what went wrong
   * @param reason why
   * @param status the HTTP status
   * @param serverCode the server's code
   * @param details the error's details
   * @param requestId the request id
   */
  public AuthException(String message, Reason reason, @Nullable Integer status, @Nullable String serverCode, @Nullable Map<String, Object> details, @Nullable String requestId) {
    super(message, status, serverCode, details, requestId, null);
    this.reason = reason;
  }

  /** @return why the call was refused */
  public Reason reason() {
    return reason;
  }

  @Override
  public String code() {
    return "auth";
  }
}
