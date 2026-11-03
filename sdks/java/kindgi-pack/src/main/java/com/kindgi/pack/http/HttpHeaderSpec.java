// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.http;

import java.util.Objects;

/** A header the runtime sends with an HTTP tool's request. */
public record HttpHeaderSpec(String name, String value) {
  public HttpHeaderSpec {
    Objects.requireNonNull(name, "name");
    Objects.requireNonNull(value, "value");
  }
}
