// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl;

import com.kindgi.pack.Tool;
import java.util.Map;

/**
 * Stands in for kindgi-pack-scala's builders (this package's): a tool built here for its caller is
 * defined in the caller, not here.
 */
public final class ScalaLayer {
  private ScalaLayer() {}

  public static Tool<Map<String, Object>, Map<String, Object>> greeter(String id) {
    return Tool.define(id)
        .description("Greets, in Scala's shape.")
        .mutating(false)
        .handler((input, ctx) -> Map.of("message", "Hello, " + input.get("name") + "!"));
  }
}
