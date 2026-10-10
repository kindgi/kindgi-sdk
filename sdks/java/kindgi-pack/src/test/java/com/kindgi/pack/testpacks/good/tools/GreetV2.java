// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.good.tools;

import com.kindgi.pack.Tool;
import java.util.List;
import java.util.Map;

public final class GreetV2 {
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("acme.greet")
      .version("2.0.0")
      .effect("network", "api:greetings")
      // A required secret and an optional one (its schema accepts null), as the index keeps them.
      .set("needsSpec", Map.of("secrets", Map.of(
          "GREETINGS_KEY", Map.of("type", "string"),
          "TRANSLATE_KEY", Map.of("type", List.of("string", "null")))))
      .handler((input, ctx) -> Map.of());
}
