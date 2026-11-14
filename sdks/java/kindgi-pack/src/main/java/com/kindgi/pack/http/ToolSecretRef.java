// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.http;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * A reference to a secret the Kindgi runtime resolves when it calls an HTTP tool's authorization:
 * {@code name} is the secret's name in the store, {@code envName} the runtime environment it is set
 * in. A {@code null} {@code envName} ({@link #named}) reads it in the environment the runtime serves
 * ({@code KINDGI_ENV}; {@code local} under {@code kindgi dev}), as for the secrets a tool's code
 * declares. The Java counterpart of the TypeScript {@code ToolSecretRef}.
 */
public record ToolSecretRef(@Nullable String envName, String name) {
  public ToolSecretRef {
    Objects.requireNonNull(name, "name");
  }

  /** A secret read in the environment the runtime serves, whichever that is. */
  public static ToolSecretRef named(String name) {
    return new ToolSecretRef(null, name);
  }
}
