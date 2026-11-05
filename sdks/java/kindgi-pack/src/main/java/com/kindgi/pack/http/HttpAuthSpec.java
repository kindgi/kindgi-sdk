// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.http;

import java.util.Objects;

/**
 * How the runtime authorizes an HTTP tool's request. The secret itself never lives in the spec —
 * only a {@link ToolSecretRef}, or a connection's name, that the runtime resolves at call time.
 */
public sealed interface HttpAuthSpec permits HttpAuthSpec.Bearer, HttpAuthSpec.Header, HttpAuthSpec.Connection {

  /** A bearer token: the runtime sends {@code Authorization: Bearer <secret>}. */
  record Bearer(ToolSecretRef secretRef) implements HttpAuthSpec {
    public Bearer {
      Objects.requireNonNull(secretRef, "secretRef");
    }
  }

  /** The secret in a named header: the runtime sends {@code <headerName>: <secret>}. */
  record Header(String headerName, ToolSecretRef secretRef) implements HttpAuthSpec {
    public Header {
      Objects.requireNonNull(headerName, "headerName");
      Objects.requireNonNull(secretRef, "secretRef");
    }
  }

  /**
   * A connection the tool declares in {@code needsSpec.connections}, by its name there: the runtime
   * sends {@code Authorization: Bearer <access token>}. A 401 answer is the app refusing it: the
   * runtime renews the token once and makes the request again.
   */
  record Connection(String connection) implements HttpAuthSpec {
    public Connection {
      Objects.requireNonNull(connection, "connection");
    }
  }
}
