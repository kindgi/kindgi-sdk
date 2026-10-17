// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import java.util.List;
import java.util.Map;

public final class Noisy {
  public static final Tool<Map<String, Object>, Object> TOOL = Tool.define("conformance.noisy")
      .description("Writes to stdout and stderr, then succeeds.")
      .output(Map.of(
          "type", "object",
          "properties", Map.of("ok", Map.of("type", "boolean")),
          "required", List.of("ok")))
      .handler((input, ctx) -> {
        System.out.println("noisy: a line on stdout");
        System.out.println("{\"v\":2,\"kind\":\"result\",\"output\":{\"ok\":false}}");
        System.err.println("noisy: a line on stderr");
        return Map.of("ok", true);
      });
}
