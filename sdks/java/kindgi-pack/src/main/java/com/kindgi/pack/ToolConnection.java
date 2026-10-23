// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * One of a tool's connections to another app, as a call gets it (pack protocol 2.7.0): the account,
 * and a short-lived token for this call.
 *
 * @param connectionId the connection
 * @param app the app's entry id ({@code google})
 * @param appName the app's name for people ({@code Google})
 * @param accessToken the token, current for this call only: send it as {@code Authorization: Bearer
 *     <token>}, and never keep, print, log or return it. Printing the connection never shows it, and
 *     its JSON leaves it out.
 * @param account whose account it is
 * @param expiresAt when the token expires (ISO 8601), when the app says
 */
public record ToolConnection(
    String connectionId,
    String app,
    String appName,
    @JsonIgnore String accessToken,
    ConnectionAccount account,
    @Nullable String expiresAt) {
  /** All but {@code expiresAt} are required. */
  public ToolConnection {
    Objects.requireNonNull(connectionId, "connectionId");
    Objects.requireNonNull(app, "app");
    Objects.requireNonNull(appName, "appName");
    Objects.requireNonNull(accessToken, "accessToken");
    Objects.requireNonNull(account, "account");
  }

  /** @return the connection without its token (a connection may be logged) */
  @Override
  public String toString() {
    return "ToolConnection[connectionId=" + connectionId + ", app=" + app + ", appName=" + appName
        + ", account=" + account + ", expiresAt=" + expiresAt + "]";
  }

  /**
   * A connection as the runtime sends it in a call's {@code ctx.connections}.
   *
   * @param value one entry's value
   * @return the connection, or {@code null} when a required field is missing or not a string
   */
  static @Nullable ToolConnection fromWire(@Nullable Object value) {
    if (!(value instanceof Map<?, ?> sent) || !(sent.get("account") instanceof Map<?, ?> account)) {
      return null;
    }
    if (!(sent.get("connectionId") instanceof String connectionId)
        || !(sent.get("app") instanceof String app)
        || !(sent.get("appName") instanceof String appName)
        || !(sent.get("accessToken") instanceof String accessToken)
        || !(account.get("id") instanceof String accountId)
        || !(account.get("label") instanceof String label)) {
      return null;
    }
    String expiresAt = sent.get("expiresAt") instanceof String at ? at : null;
    return new ToolConnection(connectionId, app, appName, accessToken, new ConnectionAccount(accountId, label),
        expiresAt);
  }
}
