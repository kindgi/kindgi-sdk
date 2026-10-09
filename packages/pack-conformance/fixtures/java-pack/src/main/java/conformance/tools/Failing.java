// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import java.util.List;
import java.util.Map;

public final class Failing {
  public static final Tool<Map<String, Object>, Object> BAD_OUTPUT = Tool.define("conformance.bad-output")
      .description("Returns output that breaks its own schema.")
      .output(Map.of(
          "type", "object",
          "properties", Map.of("message", Map.of("type", "string")),
          "required", List.of("message")))
      .handler((input, ctx) -> Map.of("message", 42));

  public static final Tool<Map<String, Object>, Map<String, Object>> THROWS = Tool.define("conformance.throws")
      .description("Always fails.")
      .handler((input, ctx) -> {
        throw new IllegalStateException("boom");
      });
}
