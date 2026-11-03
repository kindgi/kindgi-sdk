// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.http;

import java.util.Objects;

/**
 * A reference to a secret the Kindgi runtime resolves when it calls an HTTP tool's authorization:
 * {@code name} is the secret's name in the store, {@code envName} the runtime environment it is set
 * in. The Java counterpart of the TypeScript {@code ToolSecretRef}.
 */
public record ToolSecretRef(String envName, String name) {
  public ToolSecretRef {
    Objects.requireNonNull(envName, "envName");
    Objects.requireNonNull(name, "name");
  }
}
