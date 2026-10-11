// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/** What the call names doesn't exist (404, 410). */
public final class NotFoundException extends KindgiApiException {
  private static final long serialVersionUID = 1L;

  /** @serial what kind of thing */
  private final String kind;
  /** @serial its id */
  private final String id;

  /**
   * @param message what went wrong
   * @param kind what kind of thing ({@code run}, from {@code run-not-found})
   * @param id its id, or {@code unknown}
   * @param status the HTTP status
   * @param serverCode the server's code
   * @param details the error's details
   * @param requestId the request id
   */
  public NotFoundException(String message, String kind, String id, @Nullable Integer status, @Nullable String serverCode, @Nullable Map<String, Object> details, @Nullable String requestId) {
    super(message, status, serverCode, details, requestId, null);
    this.kind = kind;
    this.id = id;
  }

  /** @return what kind of thing wasn't found ({@code run}), or {@code unknown} */
  public String kind() {
    return kind;
  }

  /** @return its id, or {@code unknown} */
  public String id() {
    return id;
  }

  @Override
  public String code() {
    return "not-found";
  }
}
