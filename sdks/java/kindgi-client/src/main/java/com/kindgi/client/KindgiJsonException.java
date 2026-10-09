// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

/** {@link KindgiJson} couldn't read or write a value. */
public final class KindgiJsonException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /**
   * @param message what went wrong
   * @param cause the cause
   */
  public KindgiJsonException(String message, Throwable cause) {
    super(message, cause);
  }
}
