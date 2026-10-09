// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * A Kindgi API call failed. Each failure is a subclass named after its category ({@link
 * NotFoundException}, {@link ConflictException}, …); {@link #serverCode()} keeps the server's own
 * code ({@code run-not-found}). The categories and the codes in each are the TypeScript and
 * Python clients'.
 *
 * <p>This class itself is used for an answer that doesn't match the API's schema ({@code
 * serverCode()} is {@code invalid-response}).
 */
public class KindgiApiException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /** @serial the HTTP status, when there was an answer */
  private final @Nullable Integer status;
  /** @serial the server's code */
  private final @Nullable String serverCode;
  /** @serial the error's details */
  private final transient Map<String, Object> details;
  /** @serial the request id, for support */
  private final @Nullable String requestId;

  /**
   * @param message what went wrong
   * @param status the HTTP status, when there was an answer
   * @param serverCode the server's code
   * @param details the error's details
   * @param requestId the request id
   * @param cause the cause
   */
  public KindgiApiException(
      String message,
      @Nullable Integer status,
      @Nullable String serverCode,
      @Nullable Map<String, Object> details,
      @Nullable String requestId,
      @Nullable Throwable cause) {
    super(message, cause);
    this.status = status;
    this.serverCode = serverCode;
    this.details = details == null ? Map.of() : Map.copyOf(withoutNulls(details));
    this.requestId = requestId;
  }

  private static Map<String, Object> withoutNulls(Map<String, Object> m) {
    Map<String, Object> out = new java.util.LinkedHashMap<>();
    m.forEach((k, v) -> {
      if (k != null && v != null) {
        out.put(k, v);
      }
    });
    return out;
  }

  /**
   * The category: {@code network}, {@code auth}, {@code rate-limited}, {@code not-found}, {@code
   * conflict}, {@code invalid-request}, {@code guardrail-violation} or {@code server}.
   *
   * @return the category
   */
  public String code() {
    return "server";
  }

  /** @return the HTTP status, or {@code null} when there was no answer */
  public @Nullable Integer status() {
    return status;
  }

  /** @return the server's own code ({@code run-not-found}), or {@code null} */
  public @Nullable String serverCode() {
    return serverCode;
  }

  /** @return the error's details, as the server sent them */
  public Map<String, Object> details() {
    return details;
  }

  /** @return the request id, for support, or {@code null} */
  public @Nullable String requestId() {
    return requestId;
  }

  @Override
  public String toString() {
    return getClass().getSimpleName() + "(" + getMessage() + ", status=" + status + ", serverCode=" + serverCode + ")";
  }
}
