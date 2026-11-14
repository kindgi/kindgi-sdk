// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import com.kindgi.pack.ToolFailureException;
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

  public static final Tool<Map<String, Object>, Map<String, Object>> FAILS_ON_PURPOSE =
      Tool.define("conformance.fails-on-purpose")
          .description("Fails the call on purpose: no order Z-9.")
          .handler((input, ctx) -> {
            String code = Boolean.TRUE.equals(input.get("bad")) ? "Order Not Found" : "order-not-found";
            throw new ToolFailureException(code, "No order Z-9", Map.of("orderId", "Z-9"));
          });
}
