// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * The app refused a connection's token: an HTTP 401 from its API. Throw it with the tool's name for
 * the connection (its {@code needsSpec.connections} key), or throw your own exception with it as the
 * cause. The call answers {@code connection-rejected}, and the runtime renews that token once and
 * runs the call again; it never removes the connection.
 */
public final class ConnectionRejectedException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /** The code the call answers. */
  public static final String CODE = "connection-rejected";

  private final String connection;

  /**
   * @param connection the tool's name for the connection
   */
  public ConnectionRejectedException(String connection) {
    this(connection, null);
  }

  /**
   * @param connection the tool's name for the connection
   * @param message what the app said; never the token
   */
  public ConnectionRejectedException(String connection, @Nullable String message) {
    super(message != null ? message : "the app refused the connection \"" + connection + "\"");
    this.connection = Objects.requireNonNull(connection, "connection");
  }

  /** @return the tool's name for the connection */
  public String connection() {
    return connection;
  }
}
